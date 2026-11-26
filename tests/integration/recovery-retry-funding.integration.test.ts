import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLogger, type LogRecord } from "@modainteract/moda-interact-shared/logging";
import { InitialOutreachCreditService } from "../../src/services/recovery-billing/initial-outreach-credit.service.js";
import { retryOutreachAttemptId } from "../../src/domain/recovery-outreach-identity.js";
import { RecoveryBillingService } from "../../src/services/recovery-billing.service.js";
import { RecoveryDeliveryCompensationService } from "../../src/services/recovery-delivery-compensation/reconcile.service.js";
import { adoptInitial, exactBlockSource } from "../../src/services/recovery-allowance/storage.js";
import { createInitialOutreachCreditFixture } from "./fixtures/arch056-initial-outreach-credit.fixture.js";

// These tests construct durable provider outcomes; they never send messages.
// Run through scripts/test-integration.mjs (disposable PostgreSQL and Redis).
const suite = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
const limits = { outboundHardLimit: 20, terminalMessageReservedSlots: 2 };
type Fixture = Awaited<ReturnType<typeof createInitialOutreachCreditFixture>>;

async function prepareFailedOriginal(f: Fixture, providerFailureCode = "131016", withAllowance = false) {
  const conversation = await f.db.conversation.findFirstOrThrow({ where: { checkoutRecoveryId: f.recoveryId } });
  expect(await f.service.settleConfirmedInitialOutreach({ shopId: f.shopId, recoveryId: f.recoveryId,
    outreachAttemptId: f.attemptId, outboundMessageId: f.messageId })).toMatchObject({ kind: "settled", disposition: "committed" });
  const allowance = withAllowance ? await f.db.$transaction(tx => adoptInitial(tx, conversation.id, limits)) : null;
  await f.db.conversationMessage.update({ where: { id: f.messageId }, data: { status: "FAILED", providerFailureCode,
    failedAt: new Date(f.sentAt.getTime() + 1_000) } });
  const records: LogRecord[] = [];
  const logger = createLogger({ serviceName: "recovery-test", environment: "test", sink: record => records.push(record) });
  const compensation = new RecoveryDeliveryCompensationService(f.db, () => new Date(), logger);
  expect(await compensation.reconcile(f.providerMessageId)).toBe("restored-spendable");
  const intent = await f.db.recoveryOutreachRetryIntent.findUniqueOrThrow({ where: { failedAttemptId: f.attemptId } });
  expect(records).toContainEqual(expect.objectContaining({ level: "info", event: "recovery.delivery_retry.intent_recorded", data: expect.objectContaining({
    shopId: f.shopId, checkoutRecoveryId: f.recoveryId, conversationId: conversation.id, retryIntentId: intent.id,
    failedAttemptId: f.attemptId, failedMessageId: f.messageId, fundingReservationId: intent.fundingReservationId,
    providerFailureCode, policy: intent.policy, compensationOutcome: "restored-spendable",
  }) }));
  const retryId = retryOutreachAttemptId(intent.id);
  await f.db.recoveryOutreachAttempt.create({ data: { id: retryId, checkoutRecoveryId: f.recoveryId,
    sequence: 3, trigger: "INITIAL", recipient: "15551234567", configuredOfferMode: "NONE" } });
  const original = await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId! } });
  expect(original.compensationUsageEventId).toBeTruthy();
  const request = { shopId: f.shopId, recoveryId: f.recoveryId, outreachAttemptId: retryId };
  return { conversation, intent, retryId, request, original, allowance, compensation, records, logger,
    billing: new RecoveryBillingService(f.db) };
}

async function simulatedReceipt(f: Fixture, retry: Awaited<ReturnType<typeof prepareFailedOriginal>>, delivered: boolean) {
  const now = new Date();
  const message = await f.db.conversationMessage.create({ data: { conversationId: retry.conversation.id,
    direction: "OUTBOUND", senderType: "AUTOMATION", status: delivered ? "DELIVERED" : "SENT",
    content: "Retry outreach fixture", providerMessageId: `wamid-${randomUUID()}`, sentAt: now,
    ...(delivered ? { deliveredAt: now } : {}) } });
  await f.db.usageEvent.create({ data: { shopId: f.shopId, provider: f.provider,
    metric: "OUTBOUND_AUTOMATED_MESSAGE", quantity: 1, idempotencyKey: `recovery-outreach:${retry.retryId}`,
    sourceType: "OUTBOUND_AUTOMATED_MESSAGE", sourceId: message.id } });
  await f.db.recoveryOutreachAttempt.update({ where: { id: retry.retryId }, data: { outboundMessageId: message.id,
    sentAt: now, status: "WAITING_FOR_RESPONSE" } });
  return message;
}

suite("Recovery delivery retry funding (PostgreSQL)", () => {
  it.each(["free", "paid", "purchased", "promotional"] as const)("reserves exactly once, settles and adopts the successful %s retry", async source => {
    const f = await createInitialOutreachCreditFixture({ source, sentAgeMs: 60 * 60_000 });
    try {
      const retry = await prepareFailedOriginal(f);
      expect(retry.intent.policy).toBe("AFTER_COOLDOWN");
      const results = await Promise.all([retry.billing.admit(retry.request), retry.billing.admit(retry.request)]);
      expect(results[0]).toMatchObject({ kind: "admitted", admission: { kind: source === "free" ? "lifetime-free" : source } });
      expect(results[1]).toMatchObject({ kind: "admitted" });
      if (results[0]?.kind !== "admitted" || results[1]?.kind !== "admitted") throw new Error("Retry funding was not admitted");
      expect(results[1].admission.sourceKey).toBe(results[0].admission.sourceKey);
      const fresh = await f.db.usageReservation.findFirstOrThrow({ where: { shopId: f.shopId, status: "RESERVED" } });
      expect(fresh.id).not.toBe(retry.original.id);
      // A pre-existing durable reservation is replayed, not newly charged.
      const retryCredit = new InitialOutreachCreditService(f.db, retry.logger);
      const replay = await retryCredit.admitInitialRetry(retry.request, async () => { throw new Error("must not reserve again"); });
      expect(replay.result.kind).toBe("admitted");
      expect(retry.records).toContainEqual(expect.objectContaining({ event: "recovery.delivery_retry.funding_replayed", data: expect.objectContaining({
        retryIntentId: retry.intent.id, outreachAttemptId: retry.retryId, fundingReservationId: fresh.id,
      }) }));
      expect(await f.db.usageReservation.count({ where: { shopId: f.shopId } })).toBe(2);
      const message = await simulatedReceipt(f, retry, true);
      const input = { ...retry.request, outboundMessageId: message.id };
      expect(await f.service.settleConfirmedInitialOutreach(input)).toMatchObject({ kind: "settled", reservationId: fresh.id });
      expect(await f.service.settleConfirmedInitialOutreach(input)).toMatchObject({ kind: "settled", disposition: "already-committed", reservationId: fresh.id });
      const block = await f.db.$transaction(tx => adoptInitial(tx, retry.conversation.id, limits));
      expect(block).toMatchObject({ ordinal: 0, fundingKind: "INITIAL", creditReservationId: fresh.id });
      expect(await f.db.$transaction(tx => exactBlockSource(tx, block))).toMatchObject({ reservation: { id: fresh.id } });
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: retry.original.id } })).toEqual(retry.original);
      const sum = await f.db.usageEvent.aggregate({ where: { shopId: f.shopId, metric: "RECOVERY_CONVERSATION" }, _sum: { quantity: true } });
      expect(sum._sum.quantity?.toNumber()).toBe(1);
    } finally { await f.close(); }
  }, 60_000);

  it("compensates a failed physical retry independently and preserves the original correction on replay", async () => {
    const f = await createInitialOutreachCreditFixture({ sentAgeMs: 60 * 60_000 });
    try {
      const retry = await prepareFailedOriginal(f);
      expect(await retry.billing.admit(retry.request)).toMatchObject({ kind: "admitted" });
      const fresh = await f.db.usageReservation.findFirstOrThrow({ where: { shopId: f.shopId, status: "RESERVED" } });
      const message = await simulatedReceipt(f, retry, false);
      expect(await f.service.settleConfirmedInitialOutreach({ ...retry.request, outboundMessageId: message.id })).toMatchObject({ kind: "settled", reservationId: fresh.id });
      await expect(f.db.$transaction(tx => adoptInitial(tx, retry.conversation.id, limits))).rejects.toThrow("initial-retry-delivery-unproven");
      await f.db.conversationMessage.update({ where: { id: message.id }, data: { status: "FAILED", providerFailureCode: "131016", failedAt: new Date() } });
      expect(await retry.compensation.reconcile(message.providerMessageId!)).toBe("restored-spendable");
      expect(await retry.compensation.reconcile(message.providerMessageId!)).toBe("restored-spendable");
      const corrected = await f.db.usageReservation.findUniqueOrThrow({ where: { id: fresh.id } });
      expect(corrected.compensationUsageEventId).toBeTruthy();
      expect(corrected.compensationUsageEventId).not.toBe(retry.original.compensationUsageEventId);
      expect(await f.db.recoveryOutreachRetryIntent.findUniqueOrThrow({ where: { failedAttemptId: retry.retryId } })).toMatchObject({ fundingReservationId: fresh.id, failedMessageId: message.id });
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: retry.original.id } })).toEqual(retry.original);
      expect(await f.db.usageEvent.count({ where: { shopId: f.shopId, metric: "RECOVERY_CONVERSATION", correctionOfUsageEventId: { not: null } } })).toBe(2);
    } finally { await f.close(); }
  }, 60_000);

  it.each([{ code: "131049", withAllowance: false }, { code: "131016", withAllowance: true }])("holds $code or an existing allowance ($withAllowance) without new credit", async ({ code, withAllowance }) => {
    const f = await createInitialOutreachCreditFixture({ sentAgeMs: 48 * 60 * 60_000 });
    try {
      const retry = await prepareFailedOriginal(f, code, withAllowance);
      expect(await retry.billing.admit(retry.request)).toMatchObject({ kind: "blocked" });
      expect(await f.db.usageReservation.count({ where: { shopId: f.shopId } })).toBe(1);
      if (retry.allowance) expect(await f.db.conversationAllowanceBlock.findUniqueOrThrow({ where: { id: retry.allowance.id } })).toMatchObject({ creditReservationId: retry.original.id });
    } finally { await f.close(); }
  }, 60_000);
});
