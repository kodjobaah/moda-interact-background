import {
  BillingPeriodCloseReason,
  BillingPeriodEntitlementCounterKind,
  BillingPeriodStatus,
  BillingPlanKind,
  ShopifyReportState,
  UsageReservationReleaseReason,
  UsageReservationStatus,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";

export type CloseBillingPeriodInput = {
  billingPeriodId: string;
  planKind: BillingPlanKind;
  closedAt: Date;
  closeReason: BillingPeriodCloseReason;
  openPeriodFailureMessage: string;
  providerResponseSummary?: string;
};

export async function closeBillingPeriod(
  transaction: Prisma.TransactionClient,
  input: CloseBillingPeriodInput,
): Promise<void> {
  await transaction.usageEvent.updateMany({
    where: {
      billingPeriodId: input.billingPeriodId,
      shopifyReportState: {
        in: [ShopifyReportState.PENDING, ShopifyReportState.RETRYABLE],
      },
    },
    data: {
      shopifyReportState: ShopifyReportState.NEEDS_ATTENTION,
      nextReportAt: null,
      providerErrorCode: "PERIOD_CLOSED_BEFORE_REPORT",
      ...(input.providerResponseSummary !== undefined
        ? { providerResponseSummary: input.providerResponseSummary }
        : {}),
    },
  });

  if (input.planKind === BillingPlanKind.PAID_METERED) {
    await closePaidIncludedCreditCounter(transaction, input.billingPeriodId);
  }

  const closed = await transaction.billingPeriod.updateMany({
    where: {
      id: input.billingPeriodId,
      status: BillingPeriodStatus.OPEN,
    },
    data: {
      status: BillingPeriodStatus.CLOSED,
      closedAt: input.closedAt,
      closeReason: input.closeReason,
    },
  });
  if (closed.count !== 1) {
    throw new Error(input.openPeriodFailureMessage);
  }
}

async function closePaidIncludedCreditCounter(
  transaction: Prisma.TransactionClient,
  billingPeriodId: string,
): Promise<void> {
  const counter = await transaction.billingPeriodEntitlementCounter.findUnique({
    where: {
      billingPeriodId_counter: {
        billingPeriodId,
        counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
      },
    },
  });
  if (!counter) {
    throw new Error("Paid billing period included-credit counter is missing");
  }

  const reservations = await transaction.usageReservation.aggregate({
    where: {
      billingPeriodEntitlementCounterId: counter.id,
      status: {
        in: [UsageReservationStatus.RESERVED, UsageReservationStatus.AMBIGUOUS],
      },
    },
    _sum: { quantity: true },
  });
  const reservedQuantity = Number(reservations._sum.quantity ?? 0);
  const forfeitableAfterRelease = counter.grantedQuantity
    - counter.committedQuantity
    - counter.forfeitedQuantity;
  if (forfeitableAfterRelease < 0 || reservedQuantity !== counter.reservedQuantity) {
    throw new Error("Paid billing period included-credit counter is inconsistent");
  }

  await transaction.usageReservation.updateMany({
    where: {
      billingPeriodEntitlementCounterId: counter.id,
      status: {
        in: [UsageReservationStatus.RESERVED, UsageReservationStatus.AMBIGUOUS],
      },
    },
    data: {
      status: UsageReservationStatus.RELEASED,
      releaseReason: UsageReservationReleaseReason.PERIOD_CLOSED,
    },
  });

  const updated = await transaction.billingPeriodEntitlementCounter.updateMany({
    where: {
      id: counter.id,
      version: counter.version,
      reservedQuantity: counter.reservedQuantity,
    },
    data: {
      reservedQuantity: { decrement: reservedQuantity },
      forfeitedQuantity: { increment: forfeitableAfterRelease },
      version: { increment: 1 },
    },
  });
  if (updated.count !== 1) {
    throw new Error("Paid billing period included-credit counter changed during close");
  }

  const closedCounter = await transaction.billingPeriodEntitlementCounter.findUnique({
    where: { id: counter.id },
  });
  if (!closedCounter
    || closedCounter.reservedQuantity !== 0
    || closedCounter.committedQuantity + closedCounter.forfeitedQuantity !== closedCounter.grantedQuantity) {
    throw new Error("Paid billing period included-credit counter did not close cleanly");
  }
}
