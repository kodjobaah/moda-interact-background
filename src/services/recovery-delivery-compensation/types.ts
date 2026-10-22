import type { Prisma, UsageReservation } from "@prisma/client";

export type CompensationTransaction = Prisma.TransactionClient;
export type RecoverySourceKind = "free" | "paid" | "promotional" | "purchased";
export type RecoverySource = { reservation: UsageReservation; kind: RecoverySourceKind };

export type RecoveryDeliveryCompensationOutcome =
  | "not-terminal"
  | "not-recovery"
  | "released"
  | "already-released"
  | "restored-spendable"
  | "historical-only"
  | "purchased-compensation-required";

/** A lineage error is retryable by the provider-status job; never guess another credit. */
export class RecoveryCompensationLineageError extends Error {
  constructor(reason: string) {
    super(`Recovery delivery compensation lineage: ${reason}`);
    this.name = "RecoveryCompensationLineageError";
  }
}

export function requireLineage(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new RecoveryCompensationLineageError(reason);
}
