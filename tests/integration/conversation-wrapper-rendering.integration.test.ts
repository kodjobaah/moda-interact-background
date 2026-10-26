import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { ConversationWrapperService } from "../../src/services/conversation-wrappers/service.js";
import { PrismaConversationWrapperReadRepository } from "../../src/services/conversation-wrappers/repository.js";
import { digest, stableJson } from "../../src/services/conversation-wrappers/projection.js";
import type { PreparedWrapper } from "../../src/services/conversation-wrappers/contracts.js";

const enabled = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;
const LOG = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as unknown as StructuredLogger;
const compiled: PreparedWrapper = {
  schemaVersion: 1, family: "MODA_CONVERSATION_WRAPPER", responseSlot: "response.body",
  header: [{ kind: "text", value: "Welcome to " }, { kind: "variable", name: "shop.name" }],
  body: [{ kind: "responseSlot", name: "response.body" }], footer: [{ kind: "text", value: "Goodbye" }],
  conditionals: [{ when: "checkout.available", tokens: [
    { kind: "text", value: "Your checkout: " }, { kind: "variable", name: "checkout.url" },
  ] }],
};

/** Every fixture is created through actual Prisma models and schema foreign keys. */
async function seed(db: PrismaClient) {
  const suffix = randomUUID();
  const shopId = randomUUID();
  const adminId = randomUUID();
  const customerId = randomUUID();
  const checkoutToken = `checkout-${suffix}`;
  const expectedUrl = `https://${suffix}.example.com/checkouts/${checkoutToken}`;
  await db.platformAdmin.create({ data: { id: adminId, email: `admin-${suffix}@example.com`, role: "SUPER_ADMIN" } });
  await db.shop.create({ data: { id: shopId, domain: `${suffix}.example.com`, defaultLanguageTag: "en", status: "ACTIVE" } });
  await db.shopBrand.create({ data: { shopId, brandName: "Trusted Shop" } });
  await db.customer.create({ data: { id: customerId, shopId, firstName: "Ada" } });
  const recovery = await db.checkoutRecovery.create({ data: {
    shopId, customerId, checkoutToken, generation: 1, status: "DETECTED",
    lastExternalActivityAt: new Date(Date.now() - 5 * 60_000), checkoutUrl: expectedUrl,
  } });
  const conversation = await db.conversation.create({ data: {
    type: "RECOVERY", checkoutRecoveryId: recovery.id, shopId, customerId, languageTag: "fr",
  } });
  const definitionId = `wtdef_${digest(suffix)}`;
  await db.whatsAppTemplateDefinition.create({ data: {
    id: definitionId, kind: "MODA_CONVERSATION_WRAPPER", audience: "SHARED",
    sourceLanguageTag: "en", astSchemaVersion: 1, sourceHash: digest(`source:${suffix}`),
    status: "PUBLISHED", publishedAt: new Date(), createdByAdminId: adminId,
  } });
  const contentHash = digest(stableJson(compiled));
  const locale = await db.whatsAppTemplateLocale.create({ data: {
    definitionId, languageTag: "fr", status: "REVIEWED", contentHash,
    localeAst: { schemaVersion: 1, authoring: { thisIsNotAnAst: true }, prepared: compiled },
    reviewedAt: new Date(), reviewedByAdminId: adminId,
  } });
  await db.whatsAppTemplateLocale.create({ data: {
    definitionId, languageTag: "en", status: "SOURCE_SAVED", contentHash,
    localeAst: { schemaVersion: 1, authoring: { thisIsNotAnAst: true }, prepared: compiled },
  } });
  await db.whatsAppConversationWrapperActiveSlot.create({ data: {
    audience: "SHARED", definitionId, editVersion: 1, updatedByAdminId: adminId,
  } });
  return { conversationId: conversation.id, definitionId, localeId: locale.id, shopId, customerId,
    recoveryId: recovery.id, expectedUrl, adminId };
}

enabled("ARCH-047 BG005 PostgreSQL wrapper/tenant integration", () => {
  const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
  afterAll(async () => { await db.$disconnect(); });
  const service = new ConversationWrapperService({ repository: new PrismaConversationWrapperReadRepository(db), logger: LOG });

  it("resolves the active slot and verified recovery checkout, then honours a versioned activation change", async () => {
    const fixture = await seed(db);
    try {
      const request = { conversationId: fixture.conversationId, source: "AI" as const,
        messageIdentity: "message-one", responseBody: "Answer unchanged" };
      const first = await service.renderConversationResponse(request);
      expect(first).toMatchObject({ kind: "rendered", wrapperDefinitionId: fixture.definitionId,
        localeId: fixture.localeId, audience: "SHARED", slotEditVersion: 1 });
      if (first.kind !== "rendered") throw new Error("Expected published wrapper");
      expect(first.body).toContain(fixture.expectedUrl);
      expect(first.body).toContain("Trusted Shop");
      const secondDefinitionId = `wtdef_${digest(`${fixture.definitionId}:second`)}`;
      await db.whatsAppTemplateDefinition.create({ data: {
        id: secondDefinitionId, kind: "MODA_CONVERSATION_WRAPPER", audience: "AI",
        sourceLanguageTag: "en", astSchemaVersion: 1, sourceHash: digest("another-source"),
        status: "PUBLISHED", publishedAt: new Date(), createdByAdminId: fixture.adminId,
      } });
      await db.whatsAppTemplateLocale.create({ data: {
        definitionId: secondDefinitionId, languageTag: "fr", status: "REVIEWED",
        contentHash: digest(stableJson(compiled)),
        localeAst: { schemaVersion: 1, prepared: compiled }, reviewedAt: new Date(), reviewedByAdminId: fixture.adminId,
      } });
      await db.whatsAppConversationWrapperActiveSlot.create({ data: {
        audience: "AI", definitionId: secondDefinitionId, editVersion: 1, updatedByAdminId: fixture.adminId,
      } });
      const changed = await service.renderConversationResponse({ ...request, messageIdentity: "message-two" });
      expect(changed).toMatchObject({ kind: "rendered", wrapperDefinitionId: secondDefinitionId, audience: "AI" });
      await db.whatsAppConversationWrapperActiveSlot.update({ where: { audience: "AI" },
        data: { editVersion: { increment: 1 } } });
      expect(await service.renderConversationResponse({ ...request, messageIdentity: "message-three" }))
        .toMatchObject({ kind: "rendered", audience: "AI", slotEditVersion: 2 });
      const replay = await service.renderConversationResponse({ ...request, previousApplication: first });
      expect(replay).toMatchObject({ kind: "rendered", body: first.body,
        wrapperDefinitionId: fixture.definitionId, replayed: true });
    } finally {
      await db.whatsAppConversationWrapperActiveSlot.deleteMany({ where: { audience: { in: ["SHARED", "AI"] } } });
    }
  });

  it("omits cancelled/missing checkout and refuses customer/shop linkage tampering", async () => {
    const fixture = await seed(db);
    try {
      const input = { conversationId: fixture.conversationId, source: "HUMAN" as const,
        messageIdentity: "human-command", responseBody: "Human reply" };
      await db.checkoutRecovery.update({ where: { id: fixture.recoveryId }, data: {
        checkoutUrl: "https://another-merchant.example.com/checkout/foreign",
      } });
      const foreignUrl = await service.renderConversationResponse(input);
      expect(foreignUrl).toMatchObject({ kind: "rendered" });
      if (foreignUrl.kind !== "rendered") throw new Error("Expected wrapper without unverified URL");
      expect(foreignUrl.body).not.toContain("another-merchant");
      await db.checkoutRecovery.update({ where: { id: fixture.recoveryId }, data: {
        checkoutUrl: fixture.expectedUrl,
        lastExternalActivityAt: new Date(Date.now() - 15 * 24 * 60 * 60_000),
      } });
      const stale = await service.renderConversationResponse(input);
      expect(stale).toMatchObject({ kind: "rendered" });
      if (stale.kind !== "rendered") throw new Error("Expected wrapper without stale checkout");
      expect(stale.body).not.toContain("checkout:");
      await db.checkoutRecovery.update({ where: { id: fixture.recoveryId }, data: { status: "CANCELLED" } });
      const omitted = await service.renderConversationResponse(input);
      expect(omitted).toMatchObject({ kind: "rendered" });
      if (omitted.kind !== "rendered") throw new Error("Expected plain wrapper");
      expect(omitted.body).not.toContain("checkout:");
      expect(omitted.body).not.toContain(fixture.expectedUrl);
      const otherShopId = randomUUID();
      await db.shop.create({ data: { id: otherShopId, domain: `${otherShopId}.example.com` } });
      const otherCustomer = await db.customer.create({ data: { shopId: otherShopId, firstName: "Foreign" } });
      await db.conversation.update({ where: { id: fixture.conversationId }, data: { customerId: otherCustomer.id } });
      expect(await service.renderConversationResponse(input))
        .toEqual({ kind: "rejected", reason: "TENANT_MISMATCH" });
    } finally {
      await db.whatsAppConversationWrapperActiveSlot.deleteMany({ where: { audience: "SHARED" } });
    }
  });
});
