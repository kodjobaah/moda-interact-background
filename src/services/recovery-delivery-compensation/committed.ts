import { UsageReservationCompensationDisposition } from "@prisma/client";
import { correctCommittedCounter } from "./counter-adjustment.js";
import {
  readCommittedRecoveryUsage, readCommittedCorrectionReplay,
  recordCommittedRecoveryCorrection,
} from "./committed-usage.js";
import { compensatePurchasedSource } from "./purchased.js";
import { requireLineage, type CompensationTransaction, type RecoverySource } from "./types.js";

/** All credit sources share the same immutable correction lineage and transaction. */
export async function compensateCommittedSource(
  tx: CompensationTransaction, source: RecoverySource, now: Date,
): Promise<"restored-spendable" | "held-for-refund" | "historical-only"> {
  const { reservation, kind } = source;
  if (reservation.compensationUsageEventId) {
    return readCommittedCorrectionReplay(tx, source);
  }
  requireLineage(!reservation.compensationReason && !reservation.compensationDisposition &&
    !reservation.compensatedAt, "partial compensation provenance");
  if (kind === "purchased") return compensatePurchasedSource(tx, source, now);

  const original = await readCommittedRecoveryUsage(tx, source);
  const disposition = await correctCommittedCounter(tx, source, now, original.billingPeriodId);
  await recordCommittedRecoveryCorrection(tx, source, original,
    disposition === "restored-spendable"
      ? UsageReservationCompensationDisposition.RESTORED_SPENDABLE
      : UsageReservationCompensationDisposition.HISTORICAL_ONLY,
    now);
  return disposition;
}
