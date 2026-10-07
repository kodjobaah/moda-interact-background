import { UsageMetric } from "@prisma/client";
import type { Prisma } from "@prisma/client";

export type LifetimeFreeCounterRepair =
  | { kind: "present" | "created" }
  | { kind: "history-conflict" };

export async function ensureLifetimeFreeCounterForMappedSubscription(
  transaction: Prisma.TransactionClient,
  shopId: string,
): Promise<LifetimeFreeCounterRepair> {
  const existing = await transaction.shopEntitlementCounter.findUnique({
    where: {
      shopId_counter: {
        shopId,
        counter: "LIFETIME_FREE_RECOVERY_CREDITS",
      },
    },
    select: { id: true },
  });
  if (existing) return { kind: "present" };

  // A missing counter can be repaired automatically only while there is no
  // historical recovery usage. Once a recovery conversation has been recorded,
  // recreating the counter from the platform default could silently re-grant
  // lifetime capacity that was already consumed before the counter disappeared.
  const historicalRecoveryUsage = await transaction.usageEvent.count({
    where: { shopId, metric: UsageMetric.RECOVERY_CONVERSATION },
  });
  if (historicalRecoveryUsage > 0) return { kind: "history-conflict" };

  const policy = await transaction.platformBillingPolicy.findUnique({
    where: { id: "default" },
    select: { lifetimeFreeRecoveryAllowance: true },
  });
  if (
    !policy
    || !Number.isSafeInteger(policy.lifetimeFreeRecoveryAllowance)
    || policy.lifetimeFreeRecoveryAllowance < 0
  ) {
    throw new Error("PlatformBillingPolicy.default has an invalid lifetime Free recovery allowance");
  }

  await transaction.shopEntitlementCounter.upsert({
    where: {
      shopId_counter: {
        shopId,
        counter: "LIFETIME_FREE_RECOVERY_CREDITS",
      },
    },
    update: {},
    create: {
      shopId,
      counter: "LIFETIME_FREE_RECOVERY_CREDITS",
      grantedQuantity: policy.lifetimeFreeRecoveryAllowance,
      committedQuantity: 0,
      reservedQuantity: 0,
      refundingQuantity: 0,
    },
  });
  return { kind: "created" };
}
