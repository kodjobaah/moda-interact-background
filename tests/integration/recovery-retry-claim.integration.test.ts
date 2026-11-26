import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { retryOutreachAttemptId } from "../../src/domain/recovery-outreach-identity.js";
import { InitialDeliveryRetryClaimService, listDueInitialRetryIntents } from "../../src/services/recovery-delivery-retry/claim.js";
import { RecoveryDeliveryCompensationService } from "../../src/services/recovery-delivery-compensation/reconcile.service.js";
import type { RecoveryPolicySnapshot } from "../../src/services/recovery-policy.service.js";
import { createInitialOutreachCreditFixture } from "./fixtures/arch056-initial-outreach-credit.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
const policy: RecoveryPolicySnapshot = { recoveryDelayMinutes: 15, recoveryOfferMode: "NONE", fixedShopifyDiscountId: null,
  followUpEnabled: false, followUpDelayMinutes: null, source: "MERCHANT", offerSnapshot: null };
type Fixture = Awaited<ReturnType<typeof createInitialOutreachCreditFixture>>;

async function failure(f: Fixture, code = "131016") {
  const conversation = await f.db.conversation.findUniqueOrThrow({ where: { checkoutRecoveryId: f.recoveryId } });
  // Simulate an existing verified sender assignment and the exact immutable
  // provider stamps of its accepted message. No credentials or provider calls.
  const senderPhone = BigInt(`0x${randomUUID().replace(/-/g, "")}`).toString();
  const senderAccount = "918273645546372819";
  const recipient = "15551234567";
  const sender = await f.db.whatsAppPoolSender.create({ data: { providerPhoneNumberId: senderPhone,
    providerAccountId: senderAccount, verifiedAt: f.sentAt, allocationEnabled: false } });
  const thread = await f.db.recoverySenderThread.create({ data: { canonicalRecipient: recipient,
    providerPhoneNumberId: sender.providerPhoneNumberId, openedAt: f.sentAt } });
  const route = await f.db.recoverySenderRoute.create({ data: { shopId: f.shopId, threadId: thread.id,
    canonicalRecipient: recipient, providerPhoneNumberId: sender.providerPhoneNumberId, openedAt: f.sentAt } });
  await f.db.recoverySenderAssignment.create({ data: { conversationId: conversation.id, routeId: route.id, assignedAt: f.sentAt } });
  expect(await f.service.settleConfirmedInitialOutreach({ shopId: f.shopId, recoveryId: f.recoveryId,
    outreachAttemptId: f.attemptId, outboundMessageId: f.messageId })).toMatchObject({ kind: "settled" });
  await f.db.conversationMessage.update({ where: { id: f.messageId }, data: {
    dispatchProviderAccountId: senderAccount, dispatchProviderPhoneNumberId: senderPhone,
    status: "FAILED", providerFailureCode: code, failedAt: new Date(f.sentAt.getTime() + 1_000),
  } });
  expect(await new RecoveryDeliveryCompensationService(f.db).reconcile(f.providerMessageId)).toBe("restored-spendable");
  const intent = await f.db.recoveryOutreachRetryIntent.findUniqueOrThrow({ where: { failedAttemptId: f.attemptId } });
  const original = await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: f.attemptId } });
  const reservation = await f.db.usageReservation.findUniqueOrThrow({ where: { id: intent.fundingReservationId } });
  return { conversation, intent, original, reservation, claim: new InitialDeliveryRetryClaimService(f.db) };
}

async function noFinancialOrProviderChanges(f: Fixture, setup: Awaited<ReturnType<typeof failure>>) {
  expect(await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: f.attemptId } })).toEqual(setup.original);
  expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: setup.reservation.id } })).toEqual(setup.reservation);
  expect(await f.db.usageReservation.count({ where: { shopId: f.shopId } })).toBe(1);
  expect(await f.db.conversationMessage.count({ where: { conversationId: setup.conversation.id } })).toBe(1);
  expect(await f.db.conversationAllowanceBlock.count({ where: { conversationId: setup.conversation.id } })).toBe(0);
}

suite("Initial delivery retry durable claims", () => {
  it.each(["free", "purchased"] as const)("discovers and claims exactly once for %s without sending or charging", async source => {
    const f = await createInitialOutreachCreditFixture({ source, sentAgeMs: 60 * 60_000 });
    try {
      const s = await failure(f);
      expect(s.intent.policy).toBe("AFTER_COOLDOWN");
      // Scan a bounded page after the candidate's preceding timestamp; no
      // assumptions about other test fixtures or global queue order.
      const due = await listDueInitialRetryIntents(f.db, { now: new Date(), limit: 250,
        after: { notBeforeAt: new Date(s.intent.notBeforeAt!.getTime() - 1), id: "0" } });
      expect(due.some(row => row.id === s.intent.id)).toBe(true);
      expect(await s.claim.inspect(s.intent.id)).toMatchObject({ kind: "ready", sequence: 3 });
      expect(await f.db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: f.recoveryId } })).toBe(1);
      const results = await Promise.all([s.claim.claim(s.intent.id, policy), s.claim.claim(s.intent.id, policy)]);
      expect(results.map(result => result.kind).sort()).toEqual(["claimed", "existing"]);
      expect(await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: retryOutreachAttemptId(s.intent.id) } }))
        .toMatchObject({ checkoutRecoveryId: f.recoveryId, sequence: 3, trigger: "INITIAL", status: "PENDING", outboundMessageId: null });
      // Crash/restart: the same intent can be rediscovered, and the claim replays.
      expect(await new InitialDeliveryRetryClaimService(f.db).claim(s.intent.id, policy)).toMatchObject({ kind: "existing", sequence: 3 });
      expect(await f.db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: f.recoveryId } })).toBe(2);
      await noFinancialOrProviderChanges(f, s);
    } finally { await f.close(); }
  }, 60_000);

  it("holds a marketing-policy failure even after cooldown", async () => {
    const f = await createInitialOutreachCreditFixture({ sentAgeMs: 48 * 60 * 60_000 });
    try {
      const s = await failure(f, "131049");
      expect(s.intent.policy).toBe("PROVIDER_POLICY_HOLD");
      expect(await s.claim.claim(s.intent.id, policy)).toMatchObject({ kind: "held" });
      expect(await f.db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: f.recoveryId } })).toBe(1);
      await noFinancialOrProviderChanges(f, s);
    } finally { await f.close(); }
  }, 60_000);

  it("holds a changed checkout and leaves the original funding untouched", async () => {
    const f = await createInitialOutreachCreditFixture({ sentAgeMs: 60 * 60_000 });
    try {
      const s = await failure(f);
      await f.db.checkoutRecovery.update({ where: { id: f.recoveryId }, data: { lastExternalActivityAt: new Date() } });
      expect(await s.claim.claim(s.intent.id, policy)).toMatchObject({ kind: "held" });
      expect(await f.db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: f.recoveryId } })).toBe(1);
      await noFinancialOrProviderChanges(f, s);
    } finally { await f.close(); }
  }, 60_000);
});
