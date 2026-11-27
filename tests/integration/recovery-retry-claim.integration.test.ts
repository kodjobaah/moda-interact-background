import { failure, policy, type Fixture } from "./fixtures/recovery-retry-claim.fixture.js";
import { withOneRecoveryTransactionFault } from "./fixtures/recovery-transaction-fault.fixture.js";
import { initialRetryExecutionPorts, InitialDeliveryRetryExecutionService } from "../../src/services/recovery-delivery-retry/execution.js";
import { expectedInitialRetryDispatchKey } from "../../src/services/recovery-delivery-retry/provider-dispatch-key.js";
import { RecoveryBillingService } from "../../src/services/recovery-billing.service.js";
import { OutboundWhatsAppAdmissionService } from "../../src/services/outbound-whatsapp-admission.service.js";
import { RecoveryPolicyService } from "../../src/services/recovery-policy.service.js";
import { RecoveryOutreachFinalizationService } from "../../src/services/checkout-recovery/recovery-outreach-finalization.service.js";
import { RecoveryInitialOutreachSupportNoticeService } from "../../src/services/checkout-recovery/recovery-initial-outreach-support-notice.service.js";
import { readAssignedOwner } from "../../src/services/recovery-sender-pool/inbound-authority.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { retryOutreachAttemptId } from "../../src/domain/recovery-outreach-identity.js";
import { InitialDeliveryRetryClaimService, listDueInitialRetryIntents } from "../../src/services/recovery-delivery-retry/claim.js";
import { checkInitialRetryPermit } from "../../src/services/recovery-delivery-retry/initial-permit.js";
import { lockRecoveryContext, readRecoveryWindowEvidence } from "../../src/services/recovery-conversation/recovery-conversation.sql.js";
import { createInitialOutreachCreditFixture } from "./fixtures/arch056-initial-outreach-credit.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
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

  it.each(["shop", "conversation"] as const)("fails fast on a locked %s and can claim after release", async locked => {
    const f = await createInitialOutreachCreditFixture({ sentAgeMs: 60 * 60_000 });
    try {
      const s = await failure(f);
      const owner = { shopId: f.shopId, recoveryId: f.recoveryId, contention: "nowait" as const };
      await f.db.$transaction(async blocker => {
        if (locked === "shop") await blocker.$queryRaw`SELECT id FROM commerce."Shop" WHERE id=${f.shopId} FOR UPDATE`;
        else await blocker.$queryRaw`SELECT id FROM whatsapp."Conversation" WHERE id=${s.conversation.id} FOR UPDATE`;
        // The holder cannot release until the competing transaction returns.
        // NOWAIT must return the original PostgreSQL lock conflict, not P2028.
        await expect(f.db.$transaction(tx => lockRecoveryContext(tx, s.conversation.id, owner)))
          .rejects.toMatchObject({ code: "P2010", meta: { code: "55P03" } });
      });
      expect(await f.db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: f.recoveryId } })).toBe(1);
      expect(await s.claim.claim(s.intent.id, policy)).toMatchObject({ kind: "claimed" });
      expect(await s.claim.claim(s.intent.id, policy)).toMatchObject({ kind: "existing" });
      expect(await f.db.recoveryOutreachAttempt.count({ where: { checkoutRecoveryId: f.recoveryId } })).toBe(2);
      await noFinancialOrProviderChanges(f, s);
    } finally { await f.close(); }
  }, 60_000);

  it.each(["rollback", "lost-ack"] as const)("replays a %s claim with exactly one durable successor", async fault => {
    const f = await createInitialOutreachCreditFixture({ sentAgeMs: 60 * 60_000 });
    try {
      const s = await failure(f);
      const injected = withOneRecoveryTransactionFault(f.db, fault);
      const service = new InitialDeliveryRetryClaimService(injected.database);
      expect(await service.claim(s.intent.id, policy)).toMatchObject({
        kind: fault === "rollback" ? "claimed" : "existing", attemptId: retryOutreachAttemptId(s.intent.id), sequence: 3,
      });
      expect(injected.injected()).toBe(true);
      expect(injected.calls()).toBeGreaterThanOrEqual(2);
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

// Test the shared eligibility gate with actual persisted ownership. This is not
// a provider permit or a provider call. The existing platform fences still own
// current consent, template registration, exact credit and message admission.
suite("Initial delivery retry last-mile eligibility", () => {
  it.each(["free", "purchased"] as const)("revalidates a %s retry and refuses changed activity", async source => {
    const f = await createInitialOutreachCreditFixture({ source, sentAgeMs: 60 * 60_000 });
    try {
      const s = await failure(f);
      expect(await s.claim.claim(s.intent.id, policy)).toMatchObject({kind: "claimed"});
      const attemptId = retryOutreachAttemptId(s.intent.id);
      const check = (id = attemptId) => f.db.$transaction(async tx => {
        expect(await lockRecoveryContext(tx, s.conversation.id)).toMatchObject({shopId: f.shopId, recoveryId: f.recoveryId});
        return checkInitialRetryPermit(tx, {shopId: f.shopId, recoveryId: f.recoveryId,
          conversationId: s.conversation.id, attemptId: id, recipient: "15551234567", now: new Date()});
      });
      const original = await f.db.conversationMessage.findUniqueOrThrow({where: {id: f.messageId}});
      expect(await check()).toEqual({kind: "ready", sender: {providerAccountId: original.dispatchProviderAccountId,
        providerPhoneNumberId: original.dispatchProviderPhoneNumberId}});
      expect(await check("retry_unrelated")).toMatchObject({kind: "held"});
      await f.db.checkoutRecovery.update({where: {id: f.recoveryId}, data: {lastExternalActivityAt: new Date()}});
      expect(await check()).toMatchObject({kind: "held"});
      await noFinancialOrProviderChanges(f, s);
    } finally { await f.close(); }
  }, 60_000);
});

// Exercise the real replay/finalization and inbound SQL, with a simulated
// durable provider receipt. No external WhatsApp or commerce request is made.
suite("Initial delivery retry execution replay", () => {
  it.each(["free", "purchased"] as const)("finalizes and routes an accepted %s retry without another provider call", async source => {
    const f = await createInitialOutreachCreditFixture({ source, sentAgeMs: 60 * 60_000 });
    try {
      const s = await failure(f);
      expect(await s.claim.claim(s.intent.id, policy)).toMatchObject({ kind: "claimed" });
      const attemptId = retryOutreachAttemptId(s.intent.id);
      const scope = { shopId: f.shopId, recoveryId: f.recoveryId, outreachAttemptId: attemptId };
      const original = await f.db.conversationMessage.findUniqueOrThrow({ where: { id: f.messageId } });
      const ports = initialRetryExecutionPorts();
      ports.billing = new RecoveryBillingService(f.db);
      ports.outbound = new OutboundWhatsAppAdmissionService(f.db);
      ports.policy = new RecoveryPolicyService(f.db);
      ports.finalizer = new RecoveryOutreachFinalizationService(ports.billing, new RecoveryInitialOutreachSupportNoticeService(f.db), undefined, f.db);
      const reserve = vi.spyOn(ports.outbound, "reserve").mockRejectedValue(new Error("unexpected new admission"));
      const send = vi.spyOn(ports.outbound, "resumeInitialTemplate").mockRejectedValue(new Error("unexpected provider send"));
      const wooSend = vi.spyOn(ports.wooSender, "sendInitial").mockRejectedValue(new Error("unexpected Woo provider send"));
      const executor = new InitialDeliveryRetryExecutionService(f.db, ports);
      expect(await ports.billing.admit(scope)).toMatchObject({ kind: "admitted" });
      const now = new Date();
      const message = await f.db.conversationMessage.create({ data: {
        conversationId: s.conversation.id, direction: "OUTBOUND", senderType: "AUTOMATION", status: "DELIVERED",
        content: "Simulated retry acceptance", providerMessageId: `wamid-${randomUUID()}`, sentAt: now, deliveredAt: now,
        providerDispatchKey: expectedInitialRetryDispatchKey(f.provider, f.shopId, attemptId), providerDispatchAdmittedAt: now,
        providerDispatchControlRevision: 0, dispatchProviderAccountId: original.dispatchProviderAccountId,
        dispatchProviderPhoneNumberId: original.dispatchProviderPhoneNumberId,
      } });
      await f.db.usageEvent.create({ data: { shopId: f.shopId, provider: f.provider, metric: "OUTBOUND_AUTOMATED_MESSAGE",
        quantity: 1, idempotencyKey: `recovery-outreach:${attemptId}`, sourceType: "OUTBOUND_AUTOMATED_MESSAGE", sourceId: message.id } });
      expect(await executor.execute(s.intent.id)).toEqual({ kind: "reconciled", messageId: message.id });
      expect(await executor.execute(s.intent.id)).toEqual({ kind: "reconciled", messageId: message.id });
      expect(await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({
        status: "WAITING_FOR_RESPONSE", outboundMessageId: message.id, sentAt: now,
      });
      expect(await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: f.attemptId } })).toEqual(s.original);
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: s.reservation.id } })).toEqual(s.reservation);
      expect(await f.db.usageReservation.count({ where: { shopId: f.shopId } })).toBe(2);
      expect(await f.db.usageReservation.count({ where: { shopId: f.shopId, status: "COMMITTED", compensatedAt: null } })).toBe(1);
      expect(await readAssignedOwner(f.db, s.conversation.id)).toMatchObject({ contacted: true, initialAccepted: true });
      expect(await readRecoveryWindowEvidence(f.db, { recoveryId: f.recoveryId, conversationId: s.conversation.id, now })).toMatchObject({ initialAttemptId: attemptId });
      expect(reserve).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(wooSend).not.toHaveBeenCalled();
      expect(await f.db.conversationMessage.count({ where: { conversationId: s.conversation.id } })).toBe(2);
    } finally { await f.close(); }
  }, 60_000);
  it("holds a committed provider permit with no receipt and never reserves or resubmits", async () => {
    const f = await createInitialOutreachCreditFixture({ sentAgeMs: 60 * 60_000 });
    try {
      const s = await failure(f);
      expect(await s.claim.claim(s.intent.id, policy)).toMatchObject({ kind: "claimed" });
      const attemptId = retryOutreachAttemptId(s.intent.id);
      const scope = { shopId: f.shopId, recoveryId: f.recoveryId, outreachAttemptId: attemptId };
      const ports = initialRetryExecutionPorts();
      ports.billing = new RecoveryBillingService(f.db);
      ports.outbound = new OutboundWhatsAppAdmissionService(f.db);
      expect(await ports.billing.admit(scope)).toMatchObject({ kind: "admitted" });
      const original = await f.db.conversationMessage.findUniqueOrThrow({ where: { id: f.messageId } });
      const message = await f.db.conversationMessage.create({ data: {
        conversationId: s.conversation.id, direction: "OUTBOUND", senderType: "AUTOMATION", status: "PENDING",
        content: "Simulated unknown provider outcome", providerDispatchKey: expectedInitialRetryDispatchKey(f.provider, f.shopId, attemptId),
        providerDispatchAdmittedAt: new Date(), providerDispatchControlRevision: 0,
        dispatchProviderAccountId: original.dispatchProviderAccountId, dispatchProviderPhoneNumberId: original.dispatchProviderPhoneNumberId,
      } });
      await f.db.usageEvent.create({ data: { shopId: f.shopId, provider: f.provider, metric: "OUTBOUND_AUTOMATED_MESSAGE",
        quantity: 1, idempotencyKey: `recovery-outreach:${attemptId}`, sourceType: "OUTBOUND_AUTOMATED_MESSAGE", sourceId: message.id } });
      const reserve = vi.spyOn(ports.outbound, "reserve").mockRejectedValue(new Error("unexpected admission"));
      const send = vi.spyOn(ports.outbound, "resumeInitialTemplate").mockRejectedValue(new Error("unexpected provider send"));
      const executor = new InitialDeliveryRetryExecutionService(f.db, ports);
      expect(await executor.execute(s.intent.id)).toEqual({ kind: "held", reason: "provider-outcome-unknown" });
      expect(await executor.execute(s.intent.id)).toEqual({ kind: "held", reason: "provider-outcome-unknown" });
      expect(await f.db.usageReservation.count({ where: { shopId: f.shopId, status: "RESERVED" } })).toBe(1);
      expect(await f.db.conversationMessage.count({ where: { conversationId: s.conversation.id } })).toBe(2);
      expect(reserve).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    } finally { await f.close(); }
  }, 60_000);

});
