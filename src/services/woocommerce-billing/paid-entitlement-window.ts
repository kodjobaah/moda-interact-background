const WOO_MODA_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export type WooEntitlementWindow = {
  periodStart: Date;
  periodEnd: Date;
};

export function currentWooEntitlementWindow(
  previousPeriodEnd: Date,
  now: Date,
): WooEntitlementWindow {
  if (previousPeriodEnd.getTime() > now.getTime()) {
    throw new Error("Woo entitlement boundary is not due");
  }
  const skippedPeriods = Math.floor(
    (now.getTime() - previousPeriodEnd.getTime()) / WOO_MODA_PERIOD_MS,
  );
  const periodStart = new Date(
    previousPeriodEnd.getTime() + skippedPeriods * WOO_MODA_PERIOD_MS,
  );
  return {
    periodStart,
    periodEnd: new Date(periodStart.getTime() + WOO_MODA_PERIOD_MS),
  };
}

export function nextWooEntitlementReconciliationAt(
  currentPeriodEnd: Date,
  providerCoverageEndAt: Date,
): Date {
  return new Date(Math.min(currentPeriodEnd.getTime(), providerCoverageEndAt.getTime()));
}