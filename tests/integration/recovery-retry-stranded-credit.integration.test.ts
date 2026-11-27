import { reclaimStrandedRetryCredit } from "../../src/services/recovery-delivery-retry/stranded-credit.js";
import { expectedInitialRetryDispatchKey } from "../../src/services/recovery-delivery-retry/provider-dispatch-key.js";
import { describe, expect, it } from "vitest";
import { retryOutreachAttemptId } from "../../src/domain/recovery-outreach-identity.js";
import { initialRetryExecutionPorts, InitialDeliveryRetryExecutionService } from "../../src/services/recovery-delivery-retry/execution.js";
import { RecoveryBillingService } from "../../src/services/recovery-billing.service.js";
import { OutboundWhatsAppAdmissionService } from "../../src/services/outbound-whatsapp-admission.service.js";
import { createInitialOutreachCreditFixture } from "./fixtures/arch056-initial-outreach-credit.fixture.js";
import { failure, policy } from "./fixtures/recovery-retry-claim.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

suite("Initial retry stranded pre-permit funding", () => {
  it.each(["free", "purchased"] as const)("reclaims obsolete %s credit and preserves the compensated predecessor", async source => {
    const f = await createInitialOutreachCreditFixture({ source, sentAgeMs: 60 * 60_000 });
    try {
      const s = await failure(f);
      expect(await s.claim.claim(s.intent.id, policy)).toMatchObject({ kind: "claimed" });
      const scope = { shopId: f.shopId, recoveryId: f.recoveryId, outreachAttemptId: retryOutreachAttemptId(s.intent.id), conversationId: s.conversation.id };
      const ports = initialRetryExecutionPorts();
      ports.billing = new RecoveryBillingService(f.db);
      expect(await ports.billing.admit(scope)).toMatchObject({ kind: "admitted" });
      const reservation = await f.db.usageReservation.findFirstOrThrow({ where: { shopId: f.shopId, status: "RESERVED" } });
      expect(await reclaimStrandedRetryCredit(f.db, scope)).toEqual({ kind: "held", reason: "cleanup-not-terminal" });
      await f.db.checkoutRecovery.update({ where: { id: f.recoveryId }, data: { lastExternalActivityAt: new Date() } });
      const recovery = await f.db.checkoutRecovery.findUniqueOrThrow({ where: { id: f.recoveryId } });
      const cleanup = () => ports.checkoutLease.withCheckoutLock(f.shopId, recovery.checkoutToken, () => reclaimStrandedRetryCredit(f.db, scope));
      expect(await cleanup()).toEqual({ kind: "cancelled", reason: "checkout-changed", reservationId: reservation.id });
      expect(await cleanup()).toEqual({ kind: "held", reason: "cleanup-already-cancelled" });
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({ status: "RELEASED" });
      expect(await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: scope.outreachAttemptId } })).toMatchObject({ status: "CANCELLED", outboundMessageId: null });
      expect(await f.db.recoveryOutreachRetryIntent.findUniqueOrThrow({ where: { id: s.intent.id } })).toMatchObject({ cancelledAt: expect.any(Date) });
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: s.reservation.id } })).toEqual(s.reservation);
      expect(await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: f.attemptId } })).toEqual(s.original);
      expect(await f.db.conversationMessage.count({ where: { conversationId: s.conversation.id } })).toBe(1);
      const executor = new InitialDeliveryRetryExecutionService(f.db, ports);
      expect(await executor.execute(s.intent.id)).toMatchObject({ kind: "held" });
    } finally { await f.close(); }
  }, 60_000);

  it.each([false, true])("only releases a prepared retry with no provider permit (%s)", async permitted => {
    const f = await createInitialOutreachCreditFixture({ sentAgeMs: 60 * 60_000 });
    try {
      const s = await failure(f);
      expect(await s.claim.claim(s.intent.id, policy)).toMatchObject({ kind: "claimed" });
      const scope = { shopId: f.shopId, recoveryId: f.recoveryId, outreachAttemptId: retryOutreachAttemptId(s.intent.id), conversationId: s.conversation.id };
      const ports = initialRetryExecutionPorts();
      ports.billing = new RecoveryBillingService(f.db);
      ports.outbound = new OutboundWhatsAppAdmissionService(f.db);
      expect(await ports.billing.admit(scope)).toMatchObject({ kind: "admitted" });
      const original = await f.db.conversationMessage.findUniqueOrThrow({ where: { id: f.messageId } });
      const message = await f.db.conversationMessage.create({ data: {
        conversationId: s.conversation.id, direction: "OUTBOUND", senderType: "AUTOMATION", status: "PENDING",
        content: "Simulated prepared retry", ...(permitted ? {
          providerDispatchKey: expectedInitialRetryDispatchKey(f.provider, f.shopId, scope.outreachAttemptId),
          providerDispatchAdmittedAt: new Date(), providerDispatchControlRevision: 0,
          dispatchProviderAccountId: original.dispatchProviderAccountId, dispatchProviderPhoneNumberId: original.dispatchProviderPhoneNumberId,
        } : {}),
      } });
      const usage = await f.db.usageEvent.create({ data: { shopId: f.shopId, provider: f.provider, metric: "OUTBOUND_AUTOMATED_MESSAGE",
        quantity: 1, idempotencyKey: `recovery-outreach:${scope.outreachAttemptId}`, sourceType: "OUTBOUND_AUTOMATED_MESSAGE", sourceId: message.id } });
      const reservation = await f.db.usageReservation.findFirstOrThrow({ where: { shopId: f.shopId, status: "RESERVED" } });
      await f.db.recoveryOutreachRetryIntent.update({ where: { id: s.intent.id }, data: { cancelledAt: new Date() } });
      const recovery = await f.db.checkoutRecovery.findUniqueOrThrow({ where: { id: f.recoveryId } });
      const result = await ports.checkoutLease.withCheckoutLock(f.shopId, recovery.checkoutToken, () => reclaimStrandedRetryCredit(f.db, scope));
      expect(result).toMatchObject(permitted ? { kind: "held", reason: "cleanup-provider-outcome-uncertain" } : { kind: "cancelled" });
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({ status: permitted ? "RESERVED" : "RELEASED" });
      expect(await f.db.conversationMessage.findUniqueOrThrow({ where: { id: message.id } })).toMatchObject({ status: permitted ? "PENDING" : "FAILED", providerMessageId: null });
      expect(await f.db.usageEvent.count({ where: { id: usage.id } })).toBe(permitted ? 1 : 0);
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: s.reservation.id } })).toEqual(s.reservation);
      const executor = new InitialDeliveryRetryExecutionService(f.db, ports);
      const resultPage = await executor.reconcileClaimedPage({ limit: 1, afterId: scope.outreachAttemptId.slice(0, -1) });
      expect(resultPage.outcomes[0]).toMatchObject({ attemptId: scope.outreachAttemptId, kind: permitted ? "held" : "failed" });
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({ status: permitted ? "RESERVED" : "RELEASED" });
    } finally { await f.close(); }
  }, 60_000);
});
