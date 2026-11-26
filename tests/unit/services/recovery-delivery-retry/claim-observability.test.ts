import { Prisma } from "@prisma/client";
import { createLogger, type LogRecord } from "@modainteract/moda-interact-shared/logging";
import { describe, expect, it, vi } from "vitest";
import type { RecoveryPolicySnapshot } from "../../../../src/services/recovery-policy.service.js";
import { RecoveryCompensationLineageError } from "../../../../src/services/recovery-delivery-compensation/types.js";

vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));
vi.mock("../../../../src/services/recovery-delivery-retry/funding.js", () => ({ requireInitialRetryPredecessorReady: vi.fn() }));
vi.mock("../../../../src/services/recovery-conversation/recovery-conversation.sql.js", () => ({ lockRecoveryContext: vi.fn() }));
import { InitialDeliveryRetryClaimService, listDueInitialRetryIntents } from "../../../../src/services/recovery-delivery-retry/claim.js";
import { requireInitialRetryPredecessorReady } from "../../../../src/services/recovery-delivery-retry/funding.js";
import { lockRecoveryContext } from "../../../../src/services/recovery-conversation/recovery-conversation.sql.js";

const now = new Date("2026-11-26T12:00:00Z");
const earlier = new Date("2026-11-26T10:00:00Z");
const policy: RecoveryPolicySnapshot = { recoveryDelayMinutes: 15, recoveryOfferMode: "NONE", fixedShopifyDiscountId: null,
  followUpEnabled: false, followUpDelayMinutes: null, source: "MERCHANT", offerSnapshot: null };

function capture() {
  const records: LogRecord[] = [];
  const logger = createLogger({ serviceName: "recovery-test", environment: "test", sink: record => records.push(record) });
  return { records, logger };
}

function fixture() {
  const { records, logger } = capture();
  const intent = { id: "intent-1", failedAttemptId: "attempt-1", failedMessageId: "message-1", fundingReservationId: "credit-1", cancelledAt: null };
  const original = { id: "attempt-1", checkoutRecoveryId: "recovery-1", sequence: 1, trigger: "INITIAL", recipient: "447700900001",
    initiatedBy: "AUTOMATION", status: "FAILED", sentAt: earlier, customerRespondedAt: null, outboundMessageId: "message-1",
    outboundMessage: { id: "message-1", conversationId: "conversation-1", direction: "OUTBOUND", senderType: "AUTOMATION", status: "FAILED",
      providerMessageId: "wamid-1", sentAt: earlier, failedAt: earlier, deliveredAt: null, readAt: null }, deliveryRetryIntent: intent };
  const successor = { ...original, id: "retry_intent-1", sequence: 3, initiatedBy: null, status: "PENDING", sentAt: null,
    outboundMessageId: null, outboundMessage: null, deliveryRetryIntent: null };
  const pointer = { ...intent, policy: "AFTER_COOLDOWN", notBeforeAt: earlier, providerFailureCode: "131016",
    failedAttempt: { checkoutRecovery: { id: "recovery-1", shopId: "shop-1", conversation: { id: "conversation-1" } } } };
  const owner = { id: "conversation-1", shopId: "shop-1", recoveryId: "recovery-1", checkoutToken: "checkout-1", recoveryStatus: "MESSAGE_SENT",
    mode: "AI" as const, revision: 0, inboundVersion: 0, lastInboundAt: null };
  vi.mocked(lockRecoveryContext).mockResolvedValue(owner);
  vi.mocked(requireInitialRetryPredecessorReady).mockReset().mockResolvedValue(undefined);
  const tx = {
    recoveryOutreachRetryIntent: { findUnique: vi.fn().mockResolvedValue(pointer) },
    checkoutRecovery: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: owner.recoveryId, shopId: owner.shopId, checkoutToken: owner.checkoutToken,
      generation: 1, status: "MESSAGE_SENT", lastExternalActivityAt: earlier, completedAt: null, expiredAt: null, admissionBlockReason: null, shop: { status: "ACTIVE" } }), findFirst: vi.fn().mockResolvedValue(null) },
    backgroundRuntimeConfig: { findUnique: vi.fn().mockResolvedValue({ checkoutRecoveryLifetimeDays: 21 }) },
    conversationAllowanceBlock: { count: vi.fn().mockResolvedValue(0) },
    recoveryOutreachAttempt: { findMany: vi.fn().mockResolvedValue([original]), create: vi.fn(), findUniqueOrThrow: vi.fn().mockResolvedValue({ closedAt: null, followUpDueAt: null, initiationKey: null, claimedAt: null, initiatedBy: null }) },
    recoverySenderAssignment: { findUnique: vi.fn().mockResolvedValue({ releasedAt: null, route: { closedAt: null, shopId: owner.shopId,
      canonicalRecipient: original.recipient, providerPhoneNumberId: "sender-1", thread: { closedAt: null, sender: { providerAccountId: "account-1", verifiedAt: earlier } } } }) },
    conversationMessage: { findUniqueOrThrow: vi.fn().mockResolvedValue({ dispatchProviderAccountId: "account-1", dispatchProviderPhoneNumberId: "sender-1" }) },
    usageEvent: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  const transaction = vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => {
    const result = await work(tx);
    expect(records.filter(r => r.event === "recovery.delivery_retry.claimed")).toHaveLength(0);
    return result;
  });
  return { records, pointer, owner, tx, transaction, successor, original,
    service: new InitialDeliveryRetryClaimService({ $transaction: transaction } as never, () => now, logger) };
}

describe("recovery delivery retry observability", () => {
  it("logs a bounded discovery page and the original read failure, but not an empty poll", async () => {
    const { logger, records } = capture();
    const findMany = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "intent-1", notBeforeAt: earlier }]);
    const db = { recoveryOutreachRetryIntent: { findMany } } as never;
    await expect(listDueInitialRetryIntents(db, { now, limit: 10 }, logger)).resolves.toEqual([]);
    expect(records).toHaveLength(0);
    await listDueInitialRetryIntents(db, { now, limit: 10 }, logger);
    expect(records[0]).toMatchObject({ level: "debug", event: "recovery.delivery_retry.discovered", data: { count: 1, firstIntentId: "intent-1" } });
    const original = new Error("discovery connection unavailable");
    findMany.mockRejectedValueOnce(original);
    await expect(listDueInitialRetryIntents(db, { now, limit: 10 }, logger)).rejects.toBe(original);
    expect(records.at(-1)).toMatchObject({ level: "error", event: "recovery.delivery_retry.discovery_failed", data: { sourceError: { message: original.message } } });
  });

  it("records correlated eligibility holds and leaves the claim untouched", async () => {
    const f = fixture();
    vi.mocked(lockRecoveryContext).mockResolvedValue({ ...f.owner, inboundVersion: 1 });
    await expect(f.service.claim("intent-1", policy)).resolves.toEqual({ kind: "held", reason: "recovery-ineligible" });
    expect(f.tx.recoveryOutreachAttempt.create).not.toHaveBeenCalled();
    expect(f.records.at(-1)).toMatchObject({ event: "recovery.delivery_retry.eligibility_held", data: {
      retryIntentId: "intent-1", failedAttemptId: "attempt-1", failedMessageId: "message-1", checkoutRecoveryId: "recovery-1",
      shopId: "shop-1", conversationId: "conversation-1", reason: "recovery-ineligible", holdDetail: "customer-responded" } });
  });

  it("keeps the provider-policy hold and its original explanation traceable", async () => {
    const f = fixture();
    f.pointer.policy = "PROVIDER_POLICY_HOLD";
    f.pointer.providerFailureCode = "131049";
    vi.mocked(requireInitialRetryPredecessorReady).mockRejectedValueOnce(new RecoveryCompensationLineageError("initial retry policy held: PROVIDER_POLICY_HOLD"));
    await expect(f.service.claim("intent-1", policy)).resolves.toMatchObject({ kind: "held" });
    expect(f.tx.recoveryOutreachAttempt.create).not.toHaveBeenCalled();
    expect(f.records.at(-1)).toMatchObject({ event: "recovery.delivery_retry.claim_held", data: { retryIntentId: "intent-1", providerFailureCode: "131049",
      policy: "PROVIDER_POLICY_HOLD", stage: "predecessor_funding_and_policy", errorMessage: expect.stringContaining("PROVIDER_POLICY_HOLD") } });
  });

  it("reports a new claim only after commit and replay as a separate diagnostic", async () => {
    const f = fixture();
    await expect(f.service.claim("intent-1", policy)).resolves.toMatchObject({ kind: "claimed", attemptId: "retry_intent-1" });
    expect(f.records.at(-1)).toMatchObject({ level: "info", event: "recovery.delivery_retry.claimed", data: {
      retryIntentId: "intent-1", outreachAttemptId: "retry_intent-1", sequence: 3, retryOrdinal: 1, checkoutRecoveryId: "recovery-1" } });
    f.records.length = 0;
    f.tx.recoveryOutreachAttempt.findMany.mockResolvedValue([f.original, f.successor]);
    await expect(f.service.claim("intent-1", policy)).resolves.toMatchObject({ kind: "existing" });
    expect(f.records.at(-1)).toMatchObject({ level: "debug", event: "recovery.delivery_retry.claim_replayed" });
    expect(f.tx.recoveryOutreachAttempt.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.records)).not.toContain(f.original.recipient);
  });

  it("logs a rolled-back claim failure with redacted source and cause and rethrows the same error", async () => {
    const f = fixture();
    const original = Object.assign(new Prisma.PrismaClientKnownRequestError("commit failed for phone +447700900001 token=private-value", { code: "P2028", clientVersion: "6.19.3" }), { cause: new Error("transaction not found") });
    f.transaction.mockImplementationOnce(async work => { await work(f.tx); throw original; });
    await expect(f.service.claim("intent-1", policy)).rejects.toBe(original);
    expect(f.records.some(r => r.event === "recovery.delivery_retry.claimed")).toBe(false);
    expect(f.records.at(-1)).toMatchObject({ event: "recovery.delivery_retry.claim_failed", level: "error", data: { prismaCode: "P2028", stage: "attempt_create", sourceError: {
      message: expect.stringContaining("commit failed"), cause: { message: "transaction not found" } } } });
    const emitted = JSON.stringify(f.records);
    expect(emitted).not.toContain("447700900001");
    expect(emitted).not.toContain("private-value");
  });

  it("rereads the claim after a lost transaction acknowledgement and does not create another attempt", async () => {
    const f = fixture();
    const missing = new Prisma.PrismaClientKnownRequestError("Transaction API error: Transaction not found.", { code: "P2028", clientVersion: "6.19.3" });
    f.transaction.mockImplementationOnce(async work => {
      await work(f.tx);
      f.tx.recoveryOutreachAttempt.findMany.mockResolvedValue([f.original, f.successor]);
      throw missing;
    });
    await expect(f.service.claim("intent-1", policy)).resolves.toMatchObject({ kind: "existing", attemptId: "retry_intent-1" });
    expect(f.transaction).toHaveBeenCalledTimes(2);
    expect(f.tx.recoveryOutreachAttempt.create).toHaveBeenCalledTimes(1);
    expect(f.records.some(record => record.event === "recovery.delivery_retry.claimed")).toBe(false);
    expect(f.records.find(record => record.event === "recovery.delivery_retry.claim_conflict")).toMatchObject({ data: {
      prismaCode: "P2028", transactionFailureKind: "not-found", transactionAttempt: 1, retryBackoffMs: 50,
      stageDurationsMs: expect.objectContaining({ owner_lock: expect.any(Number), transaction_commit: expect.any(Number) }),
    } });
    expect(f.records.at(-1)).toMatchObject({ event: "recovery.delivery_retry.claim_replayed", data: { transactionAttempt: 2 } });
  });

  it("stops after three closed-transaction attempts and propagates the original exception", async () => {
    const f = fixture();
    const error = new Prisma.PrismaClientKnownRequestError("Transaction API error: Transaction already closed.", { code: "P2028", clientVersion: "6.19.3" });
    f.transaction.mockRejectedValue(error);
    await expect(f.service.claim("intent-1", policy)).rejects.toBe(error);
    expect(f.transaction).toHaveBeenCalledTimes(3);
    expect(f.tx.recoveryOutreachAttempt.create).not.toHaveBeenCalled();
    expect(f.records.filter(record => record.event === "recovery.delivery_retry.claim_conflict")).toHaveLength(2);
    expect(f.records.at(-1)).toMatchObject({ event: "recovery.delivery_retry.claim_failed", data: { retryExhausted: true, transactionAttempt: 3 } });
  });

});
