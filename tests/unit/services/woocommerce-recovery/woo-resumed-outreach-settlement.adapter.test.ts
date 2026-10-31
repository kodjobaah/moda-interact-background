import { describe, expect, it, vi } from "vitest";
import { WooResumedOutreachSettlementAdapter } from "../../../../src/services/woocommerce-recovery/woo-resumed-outreach-settlement.adapter.js";

function makeAdapter(input: {
  status?: "PENDING" | "CANCELLED";
  followUpDueAt?: Date | null;
  sentAt?: Date | null;
  outboundMessageId?: string | null;
  updateCount?: number;
} = {}) {
  const attempt = {
    id: "attempt-1", checkoutRecoveryId: "recovery-1", sequence: 1, recipient: "447000111222",
    status: input.status ?? "PENDING", sentAt: input.sentAt ?? null,
    outboundMessageId: input.outboundMessageId ?? null, followUpDueAt: input.followUpDueAt ?? null,
  };
  const tx = {
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([{ id: "recovery-1", status: "CANCELLED" }])
      .mockResolvedValueOnce([{ id: "history-1" }])
      .mockResolvedValueOnce([{ id: "attempt-1" }]),
    recoveryOutreachAttempt: {
      findUnique: vi.fn(async () => attempt),
      updateMany: vi.fn(async () => ({ count: input.updateCount ?? 1 })),
    },
    usageEvent: { findUnique: vi.fn(async () => null) },
    conversationMessage: { findMany: vi.fn(async () => []) },
    usageReservation: { findUnique: vi.fn(async () => null) },
  };
  const database = { $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)) };
  const adapter = new WooResumedOutreachSettlementAdapter(database as never);
  return { adapter, tx };
}

const recovery = {
  id: "recovery-1", shopId: "woo-shop", checkoutToken: "checkout", customerId: null,
  status: "CANCELLED" as const, completedAt: null,
  shop: { platform: "WOOCOMMERCE", status: "ACTIVE" },
};
const attemptInput = {
  id: "attempt-1", sequence: 1, recipient: "447000111222", status: "PENDING" as const,
  sentAt: null, outboundMessageId: null, followUpDueAt: null,
};

describe("WooResumedOutreachSettlementAdapter cancellation transition", () => {
  it("fails closed on follow-up state before returning cancelled", async () => {
    const { adapter, tx } = makeAdapter({ followUpDueAt: new Date("2026-10-30T10:00:00Z") });

    await expect(adapter.cancelIfPrePermit({ recovery, attempt: attemptInput }))
      .rejects.toThrow("WOO_RESUMED_FOLLOW_UP_ATTEMPT_NOT_CANCELLABLE");
    expect(tx.recoveryOutreachAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("accepts an already-cancelled replay only when the persisted attempt has no send or follow-up evidence", async () => {
    const { adapter, tx } = makeAdapter({ status: "CANCELLED" });

    await expect(adapter.cancelIfPrePermit({ recovery, attempt: attemptInput }))
      .resolves.toEqual({ kind: "cancelled" });
    expect(tx.recoveryOutreachAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an already-cancelled replay that contains follow-up state", async () => {
    const { adapter, tx } = makeAdapter({
      status: "CANCELLED", followUpDueAt: new Date("2026-10-30T10:00:00Z"),
    });

    await expect(adapter.cancelIfPrePermit({ recovery, attempt: attemptInput }))
      .rejects.toThrow("WOO_RESUMED_CANCELLED_ATTEMPT_NOT_PRE_PERMIT");
    expect(tx.recoveryOutreachAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("returns cancelled only after the eligible conditional transition changes one row", async () => {
    const { adapter, tx } = makeAdapter({ updateCount: 1 });

    await expect(adapter.cancelIfPrePermit({ recovery, attempt: attemptInput }))
      .resolves.toEqual({ kind: "cancelled" });
    expect(tx.recoveryOutreachAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "attempt-1", checkoutRecoveryId: "recovery-1", sequence: 1,
        status: { in: ["PENDING", "CAPACITY_BLOCKED"] },
        sentAt: null, outboundMessageId: null, followUpDueAt: null,
      }),
      data: expect.objectContaining({ status: "CANCELLED" }),
    }));
  });

  it("rejects a zero-row conditional transition instead of reporting cancelled", async () => {
    const { adapter, tx } = makeAdapter({ updateCount: 0 });

    await expect(adapter.cancelIfPrePermit({ recovery, attempt: attemptInput }))
      .rejects.toThrow("WOO_RESUMED_ATTEMPT_CANCELLATION_CONFLICT");
    expect(tx.recoveryOutreachAttempt.updateMany).toHaveBeenCalledOnce();
  });
});
