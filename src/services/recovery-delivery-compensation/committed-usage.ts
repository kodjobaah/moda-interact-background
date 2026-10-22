import {
  Prisma, ShopifyReportState, UsageMetric,
  type UsageEvent, type UsageReservationCompensationDisposition,
} from "@prisma/client";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { requireLineage, type CompensationTransaction, type RecoverySource } from "./types.js";

const REASON = "WHATSAPP_RECIPIENT_UNDELIVERABLE" as const;

/** Prove the original source before writing a negative credit event. */
export async function readCommittedRecoveryUsage(
  tx: CompensationTransaction, source: RecoverySource,
): Promise<UsageEvent> {
  const { reservation, kind } = source;
  requireLineage(!!reservation.committedUsageEventId, "committed source usage event missing");
  const original = await tx.usageEvent.findUnique({ where: { id: reservation.committedUsageEventId! } });
  const sourceType = {
    free: "FREE_RECOVERY_RESERVATION",
    paid: "PAID_RECOVERY_CONVERSATION",
    promotional: "PROMOTIONAL_RECOVERY_CREDITS",
    purchased: "PURCHASED_RECOVERY_CREDITS",
  }[kind];
  requireLineage(original && original.shopId === reservation.shopId &&
    original.metric === UsageMetric.RECOVERY_CONVERSATION &&
    original.sourceType === sourceType &&
    original.sourceId === (kind === "paid" ? reservation.sourceKey : reservation.id) &&
    original.idempotencyKey === createRecoveryIdempotencyKey(reservation.shopId, reservation.sourceKey) &&
    original.quantity.equals(reservation.quantity) && !original.correctionOfUsageEventId &&
    (original.provider === "SHOPIFY" || original.provider === "WOOCOMMERCE"),
    "committed credit/usage lineage mismatch");
  requireLineage(await tx.usageEvent.count({ where: { correctionOfUsageEventId: original.id } }) === 0,
    "source already has an unrelated correction");
  return original;
}

/** Called inside the source-counter transaction; no provider reporting is emitted. */
export async function recordCommittedRecoveryCorrection(
  tx: CompensationTransaction, source: RecoverySource, original: UsageEvent,
  disposition: UsageReservationCompensationDisposition, now: Date,
): Promise<void> {
  const { reservation } = source;
  const correction = await tx.usageEvent.create({ data: {
    shopId: original.shopId, provider: original.provider,
    billingPeriodId: original.billingPeriodId,
    metric: UsageMetric.RECOVERY_CONVERSATION,
    quantity: new Prisma.Decimal(-reservation.quantity),
    idempotencyKey: `arch028-undelivered:${reservation.id}`,
    correctionOfUsageEventId: original.id,
    sourceType: "RECOVERY_UNDELIVERABLE_COMPENSATION", sourceId: reservation.id,
    occurredAt: now, shopifyReportState: ShopifyReportState.NOT_APPLICABLE,
    shopifyIdempotencyKey: null, shopifyEventHandle: null,
    reportAttemptCount: 0, nextReportAt: null, lastReportAttemptAt: null,
    reportedAt: null, providerErrorCode: null, providerResponseSummary: null,
  } });
  const recorded = await tx.usageReservation.updateMany({
    where: { id: reservation.id, shopId: reservation.shopId, status: "COMMITTED",
      committedUsageEventId: original.id, compensationUsageEventId: null,
      compensationReason: null, compensationDisposition: null, compensatedAt: null },
    data: { compensationUsageEventId: correction.id, compensationReason: REASON,
      compensationDisposition: disposition, compensatedAt: now },
  });
  requireLineage(recorded.count === 1, "reservation compensation conflict");
}

/** Replay must prove the exact correction, including provider attribution. */
export async function readCommittedCorrectionReplay(
  tx: CompensationTransaction, source: RecoverySource,
): Promise<"restored-spendable" | "held-for-refund" | "historical-only"> {
  const { reservation } = source;
  requireLineage(!!reservation.compensationUsageEventId && !!reservation.committedUsageEventId,
    "missing compensation reference");
  const [original, negative] = await Promise.all([
    tx.usageEvent.findUnique({ where: { id: reservation.committedUsageEventId! } }),
    tx.usageEvent.findUnique({ where: { id: reservation.compensationUsageEventId! } }),
  ]);
  requireLineage(original && negative && negative.shopId === original.shopId &&
    negative.provider === original.provider && negative.shopId === reservation.shopId &&
    negative.metric === UsageMetric.RECOVERY_CONVERSATION &&
    negative.quantity.equals(-reservation.quantity) &&
    negative.correctionOfUsageEventId === original.id &&
    negative.idempotencyKey === `arch028-undelivered:${reservation.id}` &&
    negative.sourceType === "RECOVERY_UNDELIVERABLE_COMPENSATION" &&
    negative.sourceId === reservation.id &&
    negative.shopifyReportState === ShopifyReportState.NOT_APPLICABLE &&
    !negative.shopifyIdempotencyKey && !negative.shopifyEventHandle &&
    !negative.nextReportAt && !negative.lastReportAttemptAt && !negative.reportedAt &&
    reservation.compensationReason === REASON && !!reservation.compensatedAt,
    "invalid previous compensation evidence");
  switch (reservation.compensationDisposition) {
    case "RESTORED_SPENDABLE": return "restored-spendable";
    case "HELD_FOR_REFUND": return "held-for-refund";
    case "HISTORICAL_ONLY": return "historical-only";
    default: requireLineage(false, "invalid previous compensation disposition");
  }
}
