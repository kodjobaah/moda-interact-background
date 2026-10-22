import {
  Prisma, ShopifyReportState, UsageMetric,
  UsageReservationCompensationDisposition,
} from "@prisma/client";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { correctCommittedCounter } from "./counter-adjustment.js";
import { requireLineage, type CompensationTransaction, type RecoverySource } from "./types.js";

const REASON = "WHATSAPP_RECIPIENT_UNDELIVERABLE" as const;

/** The negative event, counter delta and disposition are one serializable write. */
export async function compensateCommittedSource(
  tx: CompensationTransaction, source: RecoverySource, now: Date,
): Promise<"restored-spendable" | "historical-only" | "purchased-compensation-required"> {
  const { reservation, kind } = source;
  if (reservation.compensationUsageEventId) {
    const previous = await tx.usageEvent.findUnique({ where: { id: reservation.compensationUsageEventId } });
    requireLineage(previous && previous.correctionOfUsageEventId === reservation.committedUsageEventId &&
      previous.shopId === reservation.shopId && previous.quantity.equals(-reservation.quantity) &&
      previous.shopifyReportState === ShopifyReportState.NOT_APPLICABLE &&
      !previous.shopifyIdempotencyKey && !previous.shopifyEventHandle &&
      reservation.compensationReason === REASON &&
      !!reservation.compensationDisposition, "invalid previous compensation evidence");
    return reservation.compensationDisposition === UsageReservationCompensationDisposition.RESTORED_SPENDABLE
      ? "restored-spendable" : "historical-only";
  }
  requireLineage(!reservation.compensationReason && !reservation.compensationDisposition &&
    !reservation.compensatedAt, "partial compensation provenance");
  if (kind === "purchased") return "purchased-compensation-required";

  requireLineage(!!reservation.committedUsageEventId, "committed source usage event missing");
  const original = await tx.usageEvent.findUnique({
    where: { id: reservation.committedUsageEventId! },
  });
  const expectedSourceType = kind === "free" ? "FREE_RECOVERY_RESERVATION"
    : kind === "paid" ? "PAID_RECOVERY_CONVERSATION" : "PROMOTIONAL_RECOVERY_CREDITS";
  const expectedSourceId = kind === "paid" ? reservation.sourceKey : reservation.id;
  requireLineage(original && original.shopId === reservation.shopId &&
    original.metric === UsageMetric.RECOVERY_CONVERSATION &&
    original.sourceType === expectedSourceType && original.sourceId === expectedSourceId &&
    original.idempotencyKey === createRecoveryIdempotencyKey(reservation.shopId, reservation.sourceKey) &&
    original.quantity.equals(reservation.quantity) && !original.correctionOfUsageEventId &&
    (original.provider === "SHOPIFY" || original.provider === "WOOCOMMERCE"),
    "committed credit/usage lineage mismatch");
  const otherCorrections = await tx.usageEvent.count({
    where: { correctionOfUsageEventId: original.id },
  });
  requireLineage(otherCorrections === 0, "source already has an unrelated correction");
  const disposition = await correctCommittedCounter(tx, source, now, original.billingPeriodId);
  const correction = await tx.usageEvent.create({
    data: {
      shopId: original.shopId, provider: original.provider,
      billingPeriodId: original.billingPeriodId,
      metric: UsageMetric.RECOVERY_CONVERSATION,
      quantity: new Prisma.Decimal(-reservation.quantity),
      idempotencyKey: `arch028-undelivered:${reservation.id}`,
      correctionOfUsageEventId: original.id,
      sourceType: "RECOVERY_UNDELIVERABLE_COMPENSATION",
      sourceId: reservation.id,
      occurredAt: now,
      shopifyReportState: ShopifyReportState.NOT_APPLICABLE,
      shopifyIdempotencyKey: null,
      shopifyEventHandle: null,
      reportAttemptCount: 0,
      nextReportAt: null,
      lastReportAttemptAt: null,
      reportedAt: null,
      providerErrorCode: null,
      providerResponseSummary: null,
    },
  });
  const recorded = await tx.usageReservation.updateMany({
    where: { id: reservation.id, status: "COMMITTED", compensationUsageEventId: null },
    data: {
      compensationUsageEventId: correction.id,
      compensationReason: REASON,
      compensationDisposition: disposition === "restored-spendable"
        ? UsageReservationCompensationDisposition.RESTORED_SPENDABLE
        : UsageReservationCompensationDisposition.HISTORICAL_ONLY,
      compensatedAt: now,
    },
  });
  requireLineage(recorded.count === 1, "reservation compensation conflict");
  return disposition;
}
