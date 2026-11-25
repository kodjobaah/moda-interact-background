import { Prisma, type PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));
vi.mock("../../../../src/services/recovery-delivery-compensation/automated-usage.js", () => ({
  readExactAutomatedUsage: vi.fn(),
  removeExactAutomatedUsage: vi.fn(),
}));
vi.mock("../../../../src/services/recovery-delivery-compensation/lineage.js", () => ({
  resolveExactRecoverySource: vi.fn(),
}));
vi.mock("../../../../src/services/recovery-delivery-compensation/reserved.js", () => ({
  releaseReservedSource: vi.fn(),
}));
vi.mock("../../../../src/services/recovery-delivery-compensation/committed.js", () => ({
  compensateCommittedSource: vi.fn(),
}));

import { RecoveryDeliveryCompensationService } from
  "../../../../src/services/recovery-delivery-compensation/reconcile.service.js";
import { RecoveryCompensationLineageError } from
  "../../../../src/services/recovery-delivery-compensation/types.js";

function prismaError(code: string, message: string) {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code, clientVersion: "6.19.3",
  });
}

function harness() {
  const transaction = vi.fn();
  const findUnique = vi.fn().mockResolvedValue(null);
  const tx = { conversationMessage: { findUnique } };
  const warn = vi.fn();
  const error = vi.fn();
  const logger = { warn, error } as unknown as StructuredLogger;
  const service = new RecoveryDeliveryCompensationService(
    { $transaction: transaction } as unknown as Pick<PrismaClient, "$transaction">,
    () => new Date(),
    logger,
  );
  return { transaction, findUnique, tx, warn, error, service };
}

describe("recovery delivery compensation transaction retry", () => {
  it.each([
    ["P2028", "Transaction already closed: expired transaction"],
    ["P2028", "Transaction not found"],
    ["P2034", "Serialization conflict"],
    ["P2002", "Unique constraint conflict"],
  ])("replays the whole transaction after %s (%s)", async (code, message) => {
    const h = harness();
    const original = prismaError(code, message);
    const expiredRead = vi.fn().mockRejectedValue(original);
    h.transaction.mockImplementationOnce(
      (work: (tx: unknown) => Promise<unknown>) =>
        work({ conversationMessage: { findUnique: expiredRead } }),
    ).mockImplementationOnce(
      (work: (tx: unknown) => Promise<unknown>) => work(h.tx),
    );

    await expect(h.service.reconcile("wamid-retry")).resolves.toBe("not-terminal");
    expect(h.transaction).toHaveBeenCalledTimes(2);
    for (const call of h.transaction.mock.calls) {
      expect(call[1]).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15_000,
      });
    }
    const where = expect.objectContaining({ where: { providerMessageId: "wamid-retry" } });
    expect(expiredRead).toHaveBeenCalledWith(where);
    expect(h.findUnique).toHaveBeenCalledWith(where);
    expect(h.warn).toHaveBeenCalledWith("recovery.delivery_compensation.retry",
      expect.objectContaining({ reasonCode: code, attempt: 1, retryExhausted: false,
        error: original, databaseError: expect.objectContaining({ code }) }));
    expect(h.error).not.toHaveBeenCalled();
  });

  it("stops after three lost transactions and rethrows the final original error", async () => {
    const h = harness();
    const first = prismaError("P2028", "Transaction not found");
    const last = prismaError("P2028", "Transaction already closed");
    h.transaction.mockRejectedValueOnce(first).mockRejectedValueOnce(first).mockRejectedValueOnce(last);
    await expect(h.service.reconcileMessage("message-retry")).rejects.toBe(last);
    expect(h.transaction).toHaveBeenCalledTimes(3);
    expect(h.warn).toHaveBeenCalledTimes(2);
    expect(h.error).toHaveBeenCalledWith("recovery.delivery_compensation.failed",
      expect.objectContaining({ messageId: "message-retry", attempt: 3, maxAttempts: 3,
        retryExhausted: true, error: last, databaseError: expect.objectContaining({ code: "P2028" }) }));
  });

  it("does not internally retry a non-concurrency lineage error", async () => {
    const h = harness();
    const original = new RecoveryCompensationLineageError("reservation shop/quantity mismatch");
    h.transaction.mockRejectedValue(original);
    await expect(h.service.reconcile("wamid-lineage")).rejects.toBe(original);
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.warn).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledWith("recovery.delivery_compensation.failed",
      expect.objectContaining({ attempt: 1, retryExhausted: false, error: original }));
  });
});
