import type { EntitlementFeature, UsageMetric } from "../domain/types.js";
import prisma from "../lib/db.js";

type EntitlementMap = Partial<Record<EntitlementFeature, boolean>>;

type LimitMap = Partial<Record<UsageMetric, number | null>>;

export class EntitlementError extends Error {
  constructor(
    public readonly code:
      | "NO_ACTIVE_SUBSCRIPTION"
      | "FEATURE_NOT_AVAILABLE"
      | "USAGE_LIMIT_EXCEEDED",
    message: string,
  ) {
    super(message);
    this.name = "EntitlementError";
  }
}

class EntitlementService {
  async hasFeature(
    shopId: string,
    feature: EntitlementFeature,
  ): Promise<boolean> {
    const subscription = await this.getActiveSubscription(shopId);

    if (!subscription?.plan) {
      return false;
    }

    const entitlements = subscription.plan.entitlements as EntitlementMap;

    return entitlements[feature] === true;
  }

  async assertFeature(
    shopId: string,
    feature: EntitlementFeature,
  ): Promise<void> {
    const subscription = await this.getActiveSubscription(shopId);

    if (!subscription?.plan) {
      throw new EntitlementError(
        "NO_ACTIVE_SUBSCRIPTION",
        `Shop ${shopId} does not have an active subscription`,
      );
    }

    const entitlements = subscription.plan.entitlements as EntitlementMap;

    if (entitlements[feature] !== true) {
      throw new EntitlementError(
        "FEATURE_NOT_AVAILABLE",
        `Feature '${feature}' is not available for shop ${shopId}`,
      );
    }
  }

  async getLimit(shopId: string, metric: UsageMetric): Promise<number | null> {
    const subscription = await this.getActiveSubscription(shopId);

    if (!subscription?.plan) {
      throw new EntitlementError(
        "NO_ACTIVE_SUBSCRIPTION",
        `Shop ${shopId} does not have an active subscription`,
      );
    }

    const limits = subscription.plan.limits as LimitMap;

    return limits[metric] ?? null;
  }

  async assertUsageAvailable(
    shopId: string,
    metric: UsageMetric,
    quantity = 1,
  ): Promise<void> {
    const subscription = await this.getActiveSubscription(shopId);

    if (!subscription?.plan) {
      throw new EntitlementError(
        "NO_ACTIVE_SUBSCRIPTION",
        `Shop ${shopId} does not have an active subscription`,
      );
    }

    const limits = subscription.plan.limits as LimitMap;

    const limit = limits[metric];

    // null = unlimited
    if (limit == null) {
      return;
    }

    const periodStart =
      subscription.currentPeriodStart ?? startOfCurrentMonth();

    const periodEnd = subscription.currentPeriodEnd ?? startOfNextMonth();

    const usage = await prisma.usageEvent.aggregate({
      where: {
        shopId,
        metric,
        occurredAt: {
          gte: periodStart,
          lt: periodEnd,
        },
      },
      _sum: {
        quantity: true,
      },
    });

    const consumed = Number(usage._sum.quantity ?? 0);

    if (consumed + quantity > limit) {
      throw new EntitlementError(
        "USAGE_LIMIT_EXCEEDED",
        `Usage limit '${metric}' has been exceeded for shop ${shopId}`,
      );
    }
  }

  private async getActiveSubscription(shopId: string) {
    return prisma.subscription.findFirst({
      where: {
        shopId,
        status: {
          in: ["ACTIVE", "TRIALING"],
        },
        plan: {
          active: true,
        },
      },
      include: {
        plan: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });
  }
}

function startOfCurrentMonth(): Date {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function startOfNextMonth(): Date {
  const now = new Date();

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export const entitlementService = new EntitlementService();
