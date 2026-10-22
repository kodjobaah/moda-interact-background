import { BillingPeriodStatus, PromotionCampaignStatus } from "@prisma/client";
import { requireLineage, type CompensationTransaction, type RecoverySource } from "./types.js";

/** Source-specific counter correction; only the owning historical source is changed. */
export async function correctCommittedCounter(
  tx: CompensationTransaction, source: RecoverySource, now: Date,
  originalPeriodId: string | null,
): Promise<"restored-spendable" | "historical-only"> {
  const { reservation, kind } = source;
  const quantity = reservation.quantity;
  if (kind === "free") {
    const counter = await tx.shopEntitlementCounter.findUnique({ where: { id: reservation.counterId! } });
    requireLineage(counter?.shopId === reservation.shopId &&
      counter.counter === "LIFETIME_FREE_RECOVERY_CREDITS", "free credit counter mismatch");
    const updated = await tx.shopEntitlementCounter.updateMany({
      where: { id: counter.id, version: counter.version, committedQuantity: { gte: quantity } },
      data: { committedQuantity: { decrement: quantity }, version: { increment: 1 } },
    });
    requireLineage(updated.count === 1, "free credit counter correction conflict");
    return "restored-spendable";
  }
  if (kind === "paid") {
    const counter = await tx.billingPeriodEntitlementCounter.findUnique({
      where: { id: reservation.billingPeriodEntitlementCounterId! },
      include: { billingPeriod: true },
    });
    requireLineage(counter && counter.shopId === reservation.shopId &&
      counter.billingPeriodId === originalPeriodId &&
      counter.counter === "INCLUDED_RECOVERY_CREDITS" &&
      counter.billingPeriod.shopId === reservation.shopId, "paid credit counter/period mismatch");
    const subscription = await tx.subscription.findUnique({
      where: { shopId: reservation.shopId },
      select: { id: true, billingPeriodId: true, currentPeriodStart: true, currentPeriodEnd: true },
    });
    const period = counter.billingPeriod;
    const spendable = period.status === BillingPeriodStatus.OPEN && period.periodEnd > now &&
      !!subscription && subscription.billingPeriodId === period.id && subscription.id === period.subscriptionId &&
      subscription.currentPeriodStart?.getTime() === period.periodStart.getTime() &&
      subscription.currentPeriodEnd?.getTime() === period.periodEnd.getTime();
    const updated = await tx.billingPeriodEntitlementCounter.updateMany({
      where: { id: counter.id, version: counter.version, committedQuantity: { gte: quantity } },
      data: {
        committedQuantity: { decrement: quantity },
        // Closed/expired credits become historical forfeiture, not a make-good
        // in a successor period or a reopened historical period.
        ...(!spendable ? { forfeitedQuantity: { increment: quantity } } : {}),
        version: { increment: 1 },
      },
    });
    requireLineage(updated.count === 1, "paid credit counter correction conflict");
    return spendable ? "restored-spendable" : "historical-only";
  }
  requireLineage(kind === "promotional", "purchased credit is not a generic correction");
  const grant = await tx.promotionalCreditGrant.findUnique({
    where: { id: reservation.promotionalCreditGrantId! },
    include: { campaign: true },
  });
  requireLineage(grant?.shopId === reservation.shopId &&
    grant.campaignId === grant.campaign.id, "promotional grant mismatch");
  const spendable = grant.campaign.status === PromotionCampaignStatus.ACTIVE &&
    grant.campaign.startsAt <= now && grant.campaign.expiresAt > now;
  // A promotional grant has no forfeited counter. An expired/closed grant must
  // retain its consumed quantity, otherwise reopening the campaign later would
  // mint a new spendable credit from historical-only compensation.
  if (!spendable) return "historical-only";
  const updated = await tx.promotionalCreditGrant.updateMany({
    where: { id: grant.id, version: grant.version, committedQuantity: { gte: quantity } },
    data: { committedQuantity: { decrement: quantity }, exhaustedAt: null,
      version: { increment: 1 } },
  });
  requireLineage(updated.count === 1, "promotional grant counter correction conflict");
  return "restored-spendable";
}
