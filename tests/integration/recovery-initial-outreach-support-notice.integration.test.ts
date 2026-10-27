import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { ConfirmedInitialRecoveryOutreachInput } from
  "../../src/services/checkout-recovery/recovery-initial-outreach-support-notice.contracts.js";
import { RecoveryInitialOutreachSupportNoticeService } from
  "../../src/services/checkout-recovery/recovery-initial-outreach-support-notice.service.js";

const url = process.env.TEST_DATABASE_URL;
const withDatabase = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
const log = { info: vi.fn(), error: vi.fn() };

async function fixture(db: PrismaClient, options: {
  enabled?: boolean; settings?: boolean; sequence?: 1 | 2; trigger?: "INITIAL" | "NO_RESPONSE_FOLLOW_UP";
} = {}) {
  const suffix = randomUUID();
  const shopId = `initial-notice-${suffix}`;
  const sentAt = new Date("2026-10-27T10:00:00.000Z");
  const followUpDueAt = new Date("2026-10-27T11:00:00.000Z");
  const shop = await db.shop.create({ data: { id: shopId, domain: `${shopId}.example.test` } });
  const recovery = await db.checkoutRecovery.create({ data: {
    shopId: shop.id,
    checkoutToken: `checkout-${suffix}`,
    lastExternalActivityAt: sentAt,
  } });
  const conversation = await db.conversation.create({ data: {
    checkoutRecoveryId: recovery.id,
    shopId: shop.id,
    type: "RECOVERY",
  } });
  const attempt = await db.recoveryOutreachAttempt.create({ data: {
    checkoutRecoveryId: recovery.id,
    recipient: "447700900123",
    sequence: options.sequence ?? 1,
    trigger: options.trigger ?? "INITIAL",
    configuredOfferMode: "NONE",
  } });
  const message = await db.conversationMessage.create({ data: {
    id: `outbound-${suffix}`,
    conversationId: conversation.id,
    direction: "OUTBOUND",
    senderType: "AUTOMATION",
    status: "SENT",
    content: "A recovery message was sent.",
    sentAt,
  } });
  if (options.settings !== false) {
    await db.shopSettings.create({ data: {
      shopId: shop.id,
      notifyOnInitialRecoveryOutreach: options.enabled ?? true,
    } });
  }
  const input: ConfirmedInitialRecoveryOutreachInput = {
    shopId: shop.id,
    checkoutRecoveryId: recovery.id,
    outreachAttemptId: attempt.id,
    outboundMessageId: message.id,
    sentAt,
    followUpDueAt,
  };
  return { shopId: shop.id, recoveryId: recovery.id, conversationId: conversation.id,
    attemptId: attempt.id, messageId: message.id, sentAt, followUpDueAt, input };
}

const service = (db: PrismaClient, now = () => new Date("2026-10-27T10:01:00.000Z")) =>
  new RecoveryInitialOutreachSupportNoticeService(db, now, log);

withDatabase("initial recovery outreach Support finalisation — real PostgreSQL", () => {
  it("creates one SYSTEM notice on the enabled first transition and preserves merchant thread state", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    let shopId: string | undefined;
    try {
      const f = await fixture(db, { enabled: true });
      shopId = f.shopId;
      const thread = await db.merchantSupportThread.create({ data: {
        shopId: f.shopId,
        lastMerchantMessageAt: new Date("2026-10-27T09:00:00Z"),
        merchantMessageVersion: 7,
        needsAdminResponse: true,
      } });
      await expect(service(db).finalizeConfirmedInitial(f.input)).resolves.toEqual({
        outcome: "created", outreachAttemptId: f.attemptId,
      });
      const attempt = await db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: f.attemptId } });
      expect(attempt).toMatchObject({
        status: "WAITING_FOR_RESPONSE", outboundMessageId: f.messageId,
        sentAt: f.sentAt, followUpDueAt: f.followUpDueAt,
      });
      const message = await db.merchantSupportMessage.findUniqueOrThrow({
        where: { sourceKey: `recovery-initial-outreach:v1:${f.attemptId}` },
      });
      expect(message).toMatchObject({
        threadId: thread.id, kind: "SYSTEM", state: "AVAILABLE",
        checkoutRecoveryId: f.recoveryId, readAt: null,
        systemCode: "RECOVERY_INITIAL_OUTREACH_SENT", systemVersion: "1",
        sourceLanguageTag: "en-GB", originalBody: "A checkout recovery message was sent to a customer.",
      });
      expect(message.availableAt).toEqual(new Date("2026-10-27T10:01:00.000Z"));
      expect(await db.merchantSupportMessage.count({ where: { threadId: thread.id } })).toBe(1);
      expect(await db.merchantMessageTranslation.count({ where: { messageId: message.id } })).toBe(0);
      const updatedThread = await db.merchantSupportThread.findUniqueOrThrow({ where: { id: thread.id } });
      expect(updatedThread.lastMessageAt).toEqual(message.availableAt);
      expect(updatedThread.lastMerchantMessageAt).toEqual(new Date("2026-10-27T09:00:00Z"));
      expect(updatedThread.merchantMessageVersion).toBe(7);
      expect(updatedThread.needsAdminResponse).toBe(true);
    } finally {
      if (shopId) await db.shop.deleteMany({ where: { id: shopId } });
      await db.$disconnect();
    }
  }, 45_000);

  it("treats a missing setting as OFF and does not backfill after an opt-in flip", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    let shopId: string | undefined;
    try {
      const f = await fixture(db, { settings: false });
      shopId = f.shopId;
      await expect(service(db).finalizeConfirmedInitial(f.input)).resolves.toEqual({
        outcome: "disabled", outreachAttemptId: f.attemptId,
      });
      await db.shopSettings.create({ data: { shopId: f.shopId, notifyOnInitialRecoveryOutreach: true } });
      await expect(service(db).finalizeConfirmedInitial(f.input)).resolves.toEqual({
        outcome: "replayed", outreachAttemptId: f.attemptId,
      });
      expect(await db.merchantSupportMessage.count({ where: {
        sourceKey: `recovery-initial-outreach:v1:${f.attemptId}`,
      } })).toBe(0);
    } finally {
      if (shopId) await db.shop.deleteMany({ where: { id: shopId } });
      await db.$disconnect();
    }
  }, 45_000);

  it("does not duplicate an enabled notice if opt-in is later disabled", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    let shopId: string | undefined;
    try {
      const f = await fixture(db, { enabled: true });
      shopId = f.shopId;
      expect((await service(db).finalizeConfirmedInitial(f.input)).outcome).toBe("created");
      await db.shopSettings.update({
        where: { shopId: f.shopId }, data: { notifyOnInitialRecoveryOutreach: false },
      });
      expect((await service(db).finalizeConfirmedInitial(f.input)).outcome).toBe("replayed");
      expect(await db.merchantSupportMessage.count({ where: {
        sourceKey: `recovery-initial-outreach:v1:${f.attemptId}`,
      } })).toBe(1);
    } finally {
      if (shopId) await db.shop.deleteMany({ where: { id: shopId } });
      await db.$disconnect();
    }
  }, 45_000);

  it("serializes concurrent finalisers into one create and one replay", async () => {
    const a = new PrismaClient({ datasourceUrl: url! });
    const b = new PrismaClient({ datasourceUrl: url! });
    let shopId: string | undefined;
    try {
      const f = await fixture(a, { enabled: true });
      shopId = f.shopId;
      const outcomes = await Promise.all([
        service(a).finalizeConfirmedInitial(f.input),
        service(b).finalizeConfirmedInitial(f.input),
      ]);
      expect(outcomes.map((entry) => entry.outcome).sort()).toEqual(["created", "replayed"]);
      const thread = await a.merchantSupportThread.findUniqueOrThrow({ where: { shopId: f.shopId } });
      expect(await a.merchantSupportThread.count({ where: { shopId: f.shopId } })).toBe(1);
      expect(await a.merchantSupportMessage.count({ where: { threadId: thread.id } })).toBe(1);
    } finally {
      if (shopId) await a.shop.deleteMany({ where: { id: shopId } });
      await Promise.all([a.$disconnect(), b.$disconnect()]);
    }
  }, 45_000);

  it("rejects tenant spoofing, HUMAN attempts, and invalid persisted sender/status", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const shopIds: string[] = [];
    try {
      const spoof = await fixture(db, { enabled: true }); shopIds.push(spoof.shopId);
      await expect(service(db).finalizeConfirmedInitial({ ...spoof.input, shopId: "other-shop" }))
        .rejects.toThrow("tenant or conversation lineage");

      const conversationTenant = await fixture(db, { enabled: true }); shopIds.push(conversationTenant.shopId);
      const otherShopId = `initial-notice-other-${randomUUID()}`;
      shopIds.push(otherShopId);
      await db.shop.create({ data: { id: otherShopId, domain: `${otherShopId}.example.test` } });
      await db.conversation.update({
        where: { id: conversationTenant.conversationId }, data: { shopId: otherShopId },
      });
      await expect(service(db).finalizeConfirmedInitial(conversationTenant.input))
        .rejects.toThrow("tenant or conversation lineage");

      const human = await fixture(db, { enabled: true }); shopIds.push(human.shopId);
      await db.recoveryOutreachAttempt.update({
        where: { id: human.attemptId }, data: { initiatedBy: "HUMAN", initiationKey: `human:${human.attemptId}`, claimedAt: new Date() },
      });
      await expect(service(db).finalizeConfirmedInitial(human.input)).rejects.toThrow("attempt lineage");

      const wrongSender = await fixture(db, { enabled: true }); shopIds.push(wrongSender.shopId);
      await db.conversationMessage.update({
        where: { id: wrongSender.messageId }, data: { senderType: "HUMAN" },
      });
      await expect(service(db).finalizeConfirmedInitial(wrongSender.input)).rejects.toThrow("outbound message lineage");

      const failed = await fixture(db, { enabled: true }); shopIds.push(failed.shopId);
      await db.conversationMessage.update({
        where: { id: failed.messageId }, data: { status: "FAILED" },
      });
      await expect(service(db).finalizeConfirmedInitial(failed.input)).rejects.toThrow("outbound message lineage");
      for (const id of [spoof.attemptId, human.attemptId, wrongSender.attemptId, failed.attemptId]) {
        expect((await db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING");
      }
    } finally {
      await db.shop.deleteMany({ where: { id: { in: shopIds } } });
      await db.$disconnect();
    }
  }, 45_000);

  it("rejects invalid persisted direction, null sentAt, sequence-2 lineage, and conversation mismatch", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const shopIds: string[] = [];
    try {
      const wrongDirection = await fixture(db, { enabled: true }); shopIds.push(wrongDirection.shopId);
      await db.conversationMessage.update({
        where: { id: wrongDirection.messageId }, data: { direction: "INBOUND" },
      });
      await expect(service(db).finalizeConfirmedInitial(wrongDirection.input)).rejects.toThrow("outbound message lineage");

      const noSentAt = await fixture(db, { enabled: true }); shopIds.push(noSentAt.shopId);
      await db.conversationMessage.update({
        where: { id: noSentAt.messageId }, data: { sentAt: null },
      });
      await expect(service(db).finalizeConfirmedInitial(noSentAt.input)).rejects.toThrow("outbound message lineage");

      const followUp = await fixture(db, {
        enabled: true, sequence: 2, trigger: "NO_RESPONSE_FOLLOW_UP",
      }); shopIds.push(followUp.shopId);
      await expect(service(db).finalizeConfirmedInitial(followUp.input)).rejects.toThrow("attempt lineage");

      const wrongConversation = await fixture(db, { enabled: true }); shopIds.push(wrongConversation.shopId);
      const otherConversation = await db.conversation.create({ data: {
        shopId: wrongConversation.shopId, type: "RECOVERY",
      } });
      await db.conversationMessage.update({
        where: { id: wrongConversation.messageId }, data: { conversationId: otherConversation.id },
      });
      await expect(service(db).finalizeConfirmedInitial(wrongConversation.input)).rejects.toThrow("outbound message lineage");
    } finally {
      await db.shop.deleteMany({ where: { id: { in: shopIds } } });
      await db.$disconnect();
    }
  }, 45_000);

  it("rolls back the attempt and thread if Support insertion fails, then allows retry", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    let shopId: string | undefined;
    try {
      const f = await fixture(db, { enabled: true });
      shopId = f.shopId;
      const original = new Error("injected Support insert failure");
      const injected = {
        $transaction: (callback: (tx: unknown) => Promise<unknown>) => db.$transaction(async (tx) =>
          callback(new Proxy(tx, {
            get(target, key, receiver) {
              if (key === "merchantSupportMessage") {
                return { ...tx.merchantSupportMessage,
                  createMany: async () => { throw original; },
                };
              }
              const value = Reflect.get(target, key, receiver) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          }))),
      };
      await expect(new RecoveryInitialOutreachSupportNoticeService(injected as never, () => new Date(), log)
        .finalizeConfirmedInitial(f.input)).rejects.toBe(original);
      expect(await db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: f.attemptId } }))
        .toMatchObject({ status: "PENDING", sentAt: null, outboundMessageId: null });
      expect(await db.merchantSupportThread.count({ where: { shopId: f.shopId } })).toBe(0);
      expect(await service(db).finalizeConfirmedInitial(f.input)).toMatchObject({ outcome: "created" });
      expect(await db.merchantSupportMessage.count({ where: {
        sourceKey: `recovery-initial-outreach:v1:${f.attemptId}`,
      } })).toBe(1);
    } finally {
      if (shopId) await db.shop.deleteMany({ where: { id: shopId } });
      await db.$disconnect();
    }
  }, 45_000);

  it("fails on a conflicting sourceKey and rolls back the attempt transition", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    let shopId: string | undefined;
    try {
      const f = await fixture(db, { enabled: true });
      shopId = f.shopId;
      const thread = await db.merchantSupportThread.create({ data: { shopId: f.shopId } });
      const sourceKey = `recovery-initial-outreach:v1:${f.attemptId}`;
      await db.merchantSupportMessage.create({ data: {
        threadId: thread.id,
        kind: "SYSTEM",
        state: "AVAILABLE",
        originalBody: "Unrelated message",
        sourceLanguageTag: "en-GB",
        systemCode: "OTHER_EVENT",
        systemVersion: "1",
        sourceKey,
      } });
      await expect(service(db).finalizeConfirmedInitial(f.input)).rejects.toThrow("source key already exists");
      expect(await db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: f.attemptId } }))
        .toMatchObject({ status: "PENDING", sentAt: null, outboundMessageId: null });
      expect(await db.merchantSupportMessage.count({ where: { sourceKey } })).toBe(1);
    } finally {
      if (shopId) await db.shop.deleteMany({ where: { id: shopId } });
      await db.$disconnect();
    }
  }, 45_000);
});
