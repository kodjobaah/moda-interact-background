import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";

import { ConversationTurnProcessor } from "../../src/services/conversation-turn-processor.service.js";
import { ConversationWrapperService } from "../../src/services/conversation-wrappers/service.js";
import { PrismaConversationWrapperReadRepository } from "../../src/services/conversation-wrappers/repository.js";
import { digest, stableJson } from "../../src/services/conversation-wrappers/projection.js";
import type { PreparedWrapper } from "../../src/services/conversation-wrappers/contracts.js";

const integration = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;
const LOG = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as unknown as StructuredLogger;
const ANSWER = "Original customer-visible AI answer";

/** The composed static header/footer and conditional are the database's prepared projection. */
function prepared(header: string): PreparedWrapper {
  return {
    schemaVersion: 1, family: "MODA_CONVERSATION_WRAPPER", responseSlot: "response.body",
    header: [{ kind: "text", value: header }, { kind: "variable", name: "shop.name" }],
    body: [{ kind: "responseSlot", name: "response.body" }],
    footer: [{ kind: "text", value: "Thank you" }],
    conditionals: [{ when: "checkout.available", tokens: [
      { kind: "text", value: "Checkout: " }, { kind: "variable", name: "checkout.url" },
    ] }],
  };
}

async function seed(db: PrismaClient, wrapperHeader: string) {
  const uuid = randomUUID();
  const shopId = randomUUID();
  const customerId = randomUUID();
  const adminId = randomUUID();
  const checkoutUrl = `https://${uuid}.example.com/checkouts/${uuid}`;
  await db.platformAdmin.create({ data: { id: adminId, email: `bg008-${uuid}@example.com`, role: "SUPER_ADMIN" } });
  await db.shop.create({ data: { id: shopId, domain: `${uuid}.example.com`,
    defaultLanguageTag: "en", status: "ACTIVE" } });
  await db.shopBrand.create({ data: { shopId, brandName: "Our shop" } });
  await db.customer.create({ data: { id: customerId, shopId, firstName: "Customer", phone: "+447700900000" } });
  const recovery = await db.checkoutRecovery.create({ data: {
    shopId, customerId, checkoutToken: `bg008-${uuid}`, generation: 1,
    status: "DETECTED", lastExternalActivityAt: new Date(Date.now() - 60_000), checkoutUrl,
  } });
  const pending = new Date(Date.now() - 30_000);
  const conversation = await db.conversation.create({ data: {
    shopId, customerId, checkoutRecoveryId: recovery.id, type: "RECOVERY", languageTag: "en",
    inboundVersion: 1, lastProcessedVersion: 0,
    lastInboundAt: pending, pendingTurnStartedAt: pending,
  } });
  const definitionId = `wtdef_${digest(uuid)}`;
  await db.whatsAppTemplateDefinition.create({ data: {
    id: definitionId, kind: "MODA_CONVERSATION_WRAPPER", audience: "AI",
    sourceLanguageTag: "en", astSchemaVersion: 1, sourceHash: digest(`source:${uuid}`),
    status: "PUBLISHED", publishedAt: new Date(), createdByAdminId: adminId,
  } });
  const compilation = prepared(wrapperHeader);
  await db.whatsAppTemplateLocale.create({ data: {
    definitionId, languageTag: "en", status: "SOURCE_SAVED",
    contentHash: digest(stableJson(compilation)), localeAst: { schemaVersion: 1, prepared: compilation },
  } });
  await db.whatsAppConversationWrapperActiveSlot.create({ data: {
    audience: "AI", definitionId, editVersion: 1, updatedByAdminId: adminId,
  } });
  return { shopId, conversationId: conversation.id, checkoutUrl };
}

function createProcessor(db: PrismaClient, fixture: Awaited<ReturnType<typeof seed>>,
  moderationAllows: (text: string) => boolean) {
  const outbound = vi.fn();
  const moderated = vi.fn();
  const agent = vi.fn(async () => ({ replyText: ANSWER,
    detectedLanguageTag: null, detectedLanguageConfidence: null }));
  const reserved = vi.fn(async () => {
    const record = await db.conversationMessage.create({ data: {
      conversationId: fixture.conversationId, direction: "OUTBOUND", senderType: "AGENT",
      status: "PENDING", content: "[pending]",
    } });
    return { kind: "admitted" as const, shopId: fixture.shopId,
      conversationId: fixture.conversationId, messageId: record.id, terminal: false };
  });
  const processor = new ConversationTurnProcessor({
    queue: { add: async () => undefined },
    conversation: {
      getTurnState: async (id) => db.conversation.findUniqueOrThrow({ where: { id }, select: {
        inboundVersion: true, lastProcessedVersion: true, lastInboundAt: true,
        pendingTurnStartedAt: true, processingInboundVersion: true, processingStartedAt: true,
      } }),
      claimTurn: async (id, version, startedAt) => (await db.conversation.updateMany({
        where: { id, inboundVersion: version, lastProcessedVersion: { lt: version },
          pendingTurnStartedAt: { not: null }, processingInboundVersion: null },
        data: { processingInboundVersion: version, processingStartedAt: startedAt },
      })).count === 1,
      completeTurn: async (id, version) => (await db.conversation.updateMany({
        where: { id, inboundVersion: version, processingInboundVersion: version },
        data: { lastProcessedVersion: version, pendingTurnStartedAt: null,
          processingInboundVersion: null, processingStartedAt: null },
      })).count === 1,
      releaseTurn: async (id, version) => { await db.conversation.updateMany({
        where: { id, processingInboundVersion: version },
        data: { processingInboundVersion: null, processingStartedAt: null },
      }); },
      hasChanged: async (id, version) => {
        const row = await db.conversation.findUniqueOrThrow({ where: { id }, select: {
          inboundVersion: true, processingInboundVersion: true,
        } });
        return row.inboundVersion !== version || row.processingInboundVersion !== version;
      },
      applyDetectedLanguage: async () => true,
    },
    admission: {
      reserve: reserved,
      sendPreparedText: async ({ messageId, text }) => {
        moderated(text);
        const allowed = moderationAllows(text);
        await db.conversationMessage.update({ where: { id: messageId }, data: {
          content: text, status: allowed ? "SENT" : "FAILED",
        } });
        if (allowed) outbound(text);
        return allowed
          ? { kind: "admitted" as const, shopId: fixture.shopId,
            conversationId: fixture.conversationId, messageId, terminal: false }
          : { kind: "suppressed" as const, reason: "conversation-invalid" as const };
      },
      failPrepared: async (messageId) => { await db.conversationMessage.update({
        where: { id: messageId }, data: { status: "FAILED" },
      }); },
    },
    abuseAdmission: { admitSettledTurn: async () => ({ kind: "allowed" as const }) },
    loadTurn: async () => ({
      shopId: fixture.shopId, to: "+447700900000", customerPhone: "+447700900000",
      conversationType: "RECOVERY" as const, checkoutRecoveryId: null,
      hasReplyContext: true, context: {}, languageMessage: "Help",
    }),
    runAgent: agent,
    aiWrapper: new ConversationWrapperService({
      repository: new PrismaConversationWrapperReadRepository(db),
      onMissingSlot: "passthrough", logger: LOG,
    }),
    getResult: (result) => result,
    logger: LOG,
    runtimeConfig: { current: () => ({ conversationQuietWindowMs: 0, conversationMaxSettleWindowMs: 0 }) } as never,
  });
  return { processor, agent, reserved, outbound, moderated };
}

integration.sequential("ARCH-047 BG008 PostgreSQL AI wrapper admission", () => {
  const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
  afterAll(async () => { await db.$disconnect(); });

  it("renders the verified merchant/checkout context and persists one customer-visible send", async () => {
    const fixture = await seed(db, "Welcome to ");
    try {
      const h = createProcessor(db, fixture, () => true);
      await Promise.all([
        h.processor.process({ conversationId: fixture.conversationId, observedVersion: 1 }),
        h.processor.process({ conversationId: fixture.conversationId, observedVersion: 1 }),
      ]);
      expect(h.agent).toHaveBeenCalledOnce();
      expect(h.reserved).toHaveBeenCalledOnce();
      expect(h.outbound).toHaveBeenCalledOnce();
      expect(h.moderated).toHaveBeenCalledWith(expect.stringContaining(fixture.checkoutUrl));
      const persisted = await db.conversationMessage.findMany({ where: {
        conversationId: fixture.conversationId, direction: "OUTBOUND", senderType: "AGENT",
      } });
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.status).toBe("SENT");
      expect(persisted[0]?.content).toContain("Welcome to Our shop");
      expect(persisted[0]?.content).toContain(ANSWER);
      expect(persisted[0]?.content).toContain(fixture.checkoutUrl);
      await h.processor.process({ conversationId: fixture.conversationId, observedVersion: 1 });
      expect(h.outbound).toHaveBeenCalledOnce();
    } finally {
      await db.whatsAppConversationWrapperActiveSlot.deleteMany({ where: { audience: "AI" } });
    }
  });

  it("blocks a published wrapper's forbidden header even when the model answer is safe", async () => {
    const fixture = await seed(db, "FORBIDDEN_WRAPPER_TEXT ");
    try {
      const h = createProcessor(db, fixture, (text) => !text.includes("FORBIDDEN_WRAPPER_TEXT"));
      await h.processor.process({ conversationId: fixture.conversationId, observedVersion: 1 });
      expect(h.moderated).toHaveBeenCalledWith(expect.stringContaining("FORBIDDEN_WRAPPER_TEXT"));
      expect(h.outbound).not.toHaveBeenCalled();
      const messages = await db.conversationMessage.findMany({ where: {
        conversationId: fixture.conversationId, direction: "OUTBOUND", senderType: "AGENT",
      } });
      expect(messages).toHaveLength(1);
      expect(messages[0]?.status).toBe("FAILED");
      expect(messages[0]?.content).toContain(ANSWER);
    } finally {
      await db.whatsAppConversationWrapperActiveSlot.deleteMany({ where: { audience: "AI" } });
    }
  });
});
