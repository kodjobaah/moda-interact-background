import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  isReplayableRecoveryTransactionError, RecoveryTransactionTiming,
  recoveryTransactionBackoffMs, transactionFailureDetails,
} from "../../../../src/services/recovery-delivery-retry/transaction-resilience.js";

function prismaError(code: string, message: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: Prisma.prismaVersion.client, ...(meta ? { meta } : {}) });
}

describe("database-only recovery transaction resilience", () => {
  it.each([
    ["P2002", "Unique constraint failed"], ["P2034", "Transaction conflict"],
    ["P2028", "Transaction API error: Transaction not found."],
    ["P2028", "Transaction API error: Transaction already closed."],
    ["P2028", "A query cannot be executed on an expired transaction."],
  ])("replays recognized %s database outcomes", (code, message) => {
    expect(isReplayableRecoveryTransactionError(prismaError(code, message))).toBe(true);
  });

  it("replays only the recognized raw-query SQLSTATEs and preserves unrelated errors", () => {
    for (const code of ["40001", "40P01"]) expect(isReplayableRecoveryTransactionError(prismaError("P2010", "raw query failed", { code }))).toBe(true);
    for (const error of [prismaError("P2010", "constraint failed", { code: "23514" }),
      prismaError("P2028", "unsupported interactive transaction operation"), prismaError("P2003", "foreign key violation"),
      new Error("Transaction not found"), { code: "P2028", message: "Transaction not found" }]) {
      expect(isReplayableRecoveryTransactionError(error)).toBe(false);
    }
  });

  it("extracts the actual timeout reason after a long Prisma source excerpt without exposing secrets", () => {
    const error = prismaError("P2028", `${"source excerpt ".repeat(100)}Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 5565 ms passed since the start of the transaction. token=private-value`);
    const details = transactionFailureDetails(error);
    expect(details).toMatchObject({ transactionFailureKind: "expired", prismaTimeoutMs: 5000, prismaElapsedMs: 5565,
      transactionErrorMessage: expect.stringContaining("expired transaction") });
    expect(JSON.stringify(details)).not.toContain("private-value");
    expect(transactionFailureDetails(prismaError("P2028", "unrelated"))).toEqual({});
  });

  it("retains acquisition, repeated stage and commit timings with bounded replay backoff", async () => {
    const timing = new RecoveryTransactionTiming();
    await timing.measure(async () => {
      timing.enter("owner_lock"); timing.enter("source_lookup"); timing.enter("owner_lock");
    });
    expect(timing.snapshot()).toMatchObject({ transactionElapsedMs: expect.any(Number), stageDurationsMs: {
      transaction_acquire: expect.any(Number), identity: expect.any(Number), owner_lock: expect.any(Number),
      source_lookup: expect.any(Number), transaction_commit: expect.any(Number),
    } });
    expect([1, 2, 3, 100].map(recoveryTransactionBackoffMs)).toEqual([50, 100, 150, 250]);
  });
});
