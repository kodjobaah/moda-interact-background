import {
  BillingPeriodStatus,
  BillingPlanFeatureIdentifier,
  BillingPlanKind,
  SubscriptionProjectionStatus,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import prisma from "../lib/db.js";

export type BillingPolicyFailureReason =
  | "NO_CONTRACT"
  | "UNMAPPED_PLAN"
  | "SYNC_ERROR"
  | "SHOP_UNAVAILABLE"
  | "INVALID_CONFIGURATION";

export class EffectiveBillingPolicyError extends Error {
  constructor(
    public readonly reason: BillingPolicyFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "EffectiveBillingPolicyError";
  }
}

export type FreeAllowancePolicy = {
  grant: number;
  effective: number;
  committed: number;
  reserved: number;
  remaining: number;
};

export type PaidBillingPeriodProjection = {
  id: string;
  start: Date;
  end: Date;
  status: BillingPeriodStatus;
};

export type RecoveryCreditPackPolicy = {
  enabled: boolean;
  creditsPerPack: number;
  shopifyEventHandle: string;
  includedRecoveryConversationAllowance: number | null;
  normalRecoveryUsageQuantity: number | null;
};

export type BillingPauseReason =
  | "GLOBAL_NEW_RECOVERIES_PAUSED"
  | "SHOP_NEW_RECOVERIES_PAUSED"
  | "GLOBAL_AUTOMATED_WHATSAPP_PAUSED"
  | "SHOP_AUTOMATED_WHATSAPP_PAUSED";

export type EffectiveBillingPolicy = {
  shopId: string;
  subscriptionId: string;
  subscriptionStatus: SubscriptionProjectionStatus;
  planId: string;
  planHandle: string;
  planKind: BillingPlanKind;
  features: Record<BillingPlanFeatureIdentifier, boolean>;
  freeAllowance: FreeAllowancePolicy | null;
  shopifyUsageEventHandle: string | null;
  billingPeriod: PaidBillingPeriodProjection | null;
  recoveryCreditPack: RecoveryCreditPackPolicy | null;
  outboundSoftLimit: number;
  outboundHardLimit: number;
  terminalMessageReservedSlots: number;
  newRecoveriesPaused: boolean;
  automatedWhatsappPaused: boolean;
  paused: boolean;
  pauseReasons: BillingPauseReason[];
  policyVersions: {
    platform: number;
    shopOverride: number | null;
    plan: Date;
  };
};

export type BillingPolicyClient = Pick<
  PrismaClient,
  | "subscription"
  | "platformBillingPolicy"
  | "shopBillingPolicyOverride"
  | "shopEntitlementCounter"
  | "usageEvent"
>;

const activeSubscriptionStatuses: SubscriptionProjectionStatus[] = [
  SubscriptionProjectionStatus.ACTIVE,
  SubscriptionProjectionStatus.TRIALING,
];

const featureIdentifiers = Object.values(BillingPlanFeatureIdentifier);

export class EffectiveBillingPolicyResolver {
  constructor(private readonly client: BillingPolicyClient = prisma) {}

  async resolve(
    shopId: string,
    now = new Date(),
  ): Promise<EffectiveBillingPolicy> {
    const subscription = await this.client.subscription.findUnique({
      where: { shopId },
      include: {
        plan: { include: { features: true } },
        billingPeriod: true,
        shop: { select: { status: true } },
      },
    });

    if (!subscription || subscription.status === SubscriptionProjectionStatus.NO_CONTRACT) {
      throw new EffectiveBillingPolicyError(
        "NO_CONTRACT",
        `Shop ${shopId} has no active Shopify billing contract`,
      );
    }

    if (subscription.status === SubscriptionProjectionStatus.SYNC_ERROR) {
      throw new EffectiveBillingPolicyError(
        "SYNC_ERROR",
        `Shop ${shopId} billing projection is in sync error`,
      );
    }

    if (
      subscription.status === SubscriptionProjectionStatus.UNMAPPED ||
      !subscription.plan ||
      !subscription.plan.active ||
      !activeSubscriptionStatuses.includes(subscription.status)
    ) {
      throw new EffectiveBillingPolicyError(
        "UNMAPPED_PLAN",
        `Shop ${shopId} has no mapped active billing plan`,
      );
    }

    if (subscription.shop.status !== "ACTIVE") {
      throw new EffectiveBillingPolicyError(
        "SHOP_UNAVAILABLE",
        `Shop ${shopId} is not active`,
      );
    }

    const plan = subscription.plan;

    const [platformPolicy, override, counter] = await Promise.all([
      this.client.platformBillingPolicy.findUnique({ where: { id: "default" } }),
      this.client.shopBillingPolicyOverride.findUnique({ where: { shopId } }),
      this.client.shopEntitlementCounter.findUnique({
        where: {
          shopId_counter: { shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" },
        },
        select: { grantedQuantity: true, committedQuantity: true, reservedQuantity: true },
      }),
    ]);

    if (!platformPolicy) {
      throw invalidConfiguration(shopId, "platform policy is missing");
    }
    if (!counter) {
      throw invalidConfiguration(shopId, "lifetime Free recovery counter is missing");
    }

    const activeOverride =
      override && (override.expiresAt === null || override.expiresAt > now)
        ? override
        : null;

    const limits = resolveOutboundLimits(
      shopId,
      plan.defaultOutboundSoftLimit,
      plan.defaultOutboundHardLimit,
      platformPolicy.absoluteOutboundHardLimit,
      activeOverride,
    );

    const features = Object.fromEntries(
      featureIdentifiers.map((feature) => [
        feature,
        plan.features.some(
          (mapping) => mapping.feature === feature && mapping.enabled,
        ),
      ]),
    ) as Record<BillingPlanFeatureIdentifier, boolean>;

    const freeAllowance = resolveFreeAllowance(
      shopId,
      counter.grantedQuantity,
      counter.committedQuantity,
      counter.reservedQuantity,
    );

    if (plan.kind === BillingPlanKind.PAID_METERED && !plan.shopifyUsageEventHandle) {
      throw invalidConfiguration(shopId, "paid plan usage event handle is missing");
    }

    const packConfiguration = resolveRecoveryCreditPackConfiguration(plan);
    const normalRecoveryUsageQuantity =
      packConfiguration && plan.kind === BillingPlanKind.PAID_METERED && subscription.billingPeriod
        ? Number(
            (
              await this.client.usageEvent.aggregate({
                where: {
                  shopId,
                  billingPeriodId: subscription.billingPeriod.id,
                  metric: "RECOVERY_CONVERSATION",
                  shopifyEventHandle: plan.shopifyUsageEventHandle,
                },
                _sum: { quantity: true },
              })
            )._sum.quantity ?? 0,
          )
        : null;
    const recoveryCreditPack = packConfiguration
      ? {
          ...packConfiguration,
          normalRecoveryUsageQuantity,
          includedRecoveryConversationAllowance:
            plan.includedRecoveryConversationAllowance,
        }
      : null;

    const newRecoveriesPaused =
      platformPolicy.globalPauseNewRecoveries || activeOverride?.pauseNewRecoveries === true;
    const automatedWhatsappPaused =
      platformPolicy.globalPauseAutomatedWhatsapp ||
      activeOverride?.pauseAutomatedWhatsapp === true;
    const pauseReasons: BillingPauseReason[] = [];
    if (platformPolicy.globalPauseNewRecoveries) {
      pauseReasons.push("GLOBAL_NEW_RECOVERIES_PAUSED");
    }
    if (activeOverride?.pauseNewRecoveries === true) {
      pauseReasons.push("SHOP_NEW_RECOVERIES_PAUSED");
    }
    if (platformPolicy.globalPauseAutomatedWhatsapp) {
      pauseReasons.push("GLOBAL_AUTOMATED_WHATSAPP_PAUSED");
    }
    if (activeOverride?.pauseAutomatedWhatsapp === true) {
      pauseReasons.push("SHOP_AUTOMATED_WHATSAPP_PAUSED");
    }

    const terminalMessageReservedSlots = validateTerminalMessageReservedSlots(
      shopId,
      plan.terminalMessageReservedSlots,
      limits.hard,
    );

    return {
      shopId,
      subscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
      planId: plan.id,
      planHandle: plan.shopifyPlanHandle,
      planKind: plan.kind,
      features,
      freeAllowance,
      shopifyUsageEventHandle: plan.shopifyUsageEventHandle,
      billingPeriod:
        plan.kind === BillingPlanKind.PAID_METERED &&
        subscription.billingPeriod
          ? {
              id: subscription.billingPeriod.id,
              start: subscription.billingPeriod.periodStart,
              end: subscription.billingPeriod.periodEnd,
              status: subscription.billingPeriod.status,
            }
          : null,
          recoveryCreditPack,
      outboundSoftLimit: limits.soft,
      outboundHardLimit: limits.hard,
      terminalMessageReservedSlots,
      newRecoveriesPaused,
      automatedWhatsappPaused,
      paused: pauseReasons.length > 0,
      pauseReasons,
      policyVersions: {
        platform: platformPolicy.version,
        shopOverride: activeOverride ? activeOverride.updatedAt.getTime() : null,
        plan: plan.updatedAt,
      },
    };
  }
}

function resolveRecoveryCreditPackConfiguration(
  plan: {
    recoveryCreditPackEnabled: boolean;
    recoveryCreditsPerPack: number | null;
    shopifyRecoveryCreditPackEventHandle: string | null;
    shopifyUsageEventHandle: string | null;
    kind: BillingPlanKind;
    includedRecoveryConversationAllowance: number | null;
  },
): Omit<RecoveryCreditPackPolicy, "normalRecoveryUsageQuantity" | "includedRecoveryConversationAllowance"> | null {
  if (!plan.recoveryCreditPackEnabled) return null;
  const creditsPerPack = plan.recoveryCreditsPerPack;
  if (typeof creditsPerPack !== "number" || !Number.isSafeInteger(creditsPerPack) || creditsPerPack <= 0) return null;
  const eventHandle = plan.shopifyRecoveryCreditPackEventHandle?.trim();
  if (!eventHandle) return null;
  if (eventHandle === plan.shopifyUsageEventHandle) return null;
  const includedAllowance = plan.includedRecoveryConversationAllowance;
  if (
    plan.kind === BillingPlanKind.PAID_METERED &&
    (typeof includedAllowance !== "number" ||
      !Number.isSafeInteger(includedAllowance) ||
      includedAllowance < 0)
  ) {
    return null;
  }

  return {
    enabled: true,
    creditsPerPack,
    shopifyEventHandle: eventHandle,
  };
}

function resolveFreeAllowance(
  shopId: string,
  grant: number,
  committed: number,
  reserved: number,
): FreeAllowancePolicy {
  const grantValue = validateNonNegativeInteger(shopId, "lifetime Free grant", grant);
  const committedValue = validateNonNegativeInteger(shopId, "committed lifetime Free credits", committed);
  const reservedValue = validateNonNegativeInteger(shopId, "reserved lifetime Free credits", reserved);

  return {
    grant: grantValue,
    effective: grantValue,
    committed: committedValue,
    reserved: reservedValue,
    remaining: Math.max(grantValue - committedValue - reservedValue, 0),
  };
}

function resolveOutboundLimits(
  shopId: string,
  planSoft: number,
  planHard: number,
  platformHard: number,
  override: { outboundSoftLimit: number | null; outboundHardLimit: number | null } | null,
): { soft: number; hard: number } {
  const validatedPlanSoft = validatePositiveInteger(shopId, "plan soft limit", planSoft);
  const validatedPlanHard = validatePositiveInteger(shopId, "plan hard limit", planHard);
  const validatedPlatformHard = validatePositiveInteger(
    shopId,
    "platform hard limit",
    platformHard,
  );

  if (validatedPlanSoft > validatedPlanHard) {
    throw invalidConfiguration(shopId, "plan soft limit exceeds plan hard limit");
  }

  const overrideHard = override?.outboundHardLimit;
  const overrideSoft = override?.outboundSoftLimit;
  if (overrideHard !== null && overrideHard !== undefined) {
    validatePositiveInteger(shopId, "shop hard limit", overrideHard);
  }
  if (overrideSoft !== null && overrideSoft !== undefined) {
    validatePositiveInteger(shopId, "shop soft limit", overrideSoft);
  }
  if (
    overrideSoft !== null &&
    overrideSoft !== undefined &&
    overrideHard !== null &&
    overrideHard !== undefined &&
    overrideSoft > overrideHard
  ) {
    throw invalidConfiguration(shopId, "shop soft limit exceeds shop hard limit");
  }

  const hard = Math.min(validatedPlatformHard, overrideHard ?? validatedPlanHard);
  const soft = Math.min(hard, overrideSoft ?? validatedPlanSoft);
  return { soft, hard };
}

function validatePositiveInteger(shopId: string, label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidConfiguration(shopId, `${label} must be a finite positive integer`);
  }
  return value;
}

function validateNonNegativeInteger(shopId: string, label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidConfiguration(shopId, `${label} must be a finite non-negative integer`);
  }
  return value;
}

function validateTerminalMessageReservedSlots(
  shopId: string,
  value: number,
  effectiveHardLimit: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value >= effectiveHardLimit) {
    throw invalidConfiguration(
      shopId,
      "terminalMessageReservedSlots must be at least 1 and less than the effective hard limit",
    );
  }
  return value;
}

function invalidConfiguration(shopId: string, detail: string): EffectiveBillingPolicyError {
  return new EffectiveBillingPolicyError(
    "INVALID_CONFIGURATION",
    `Invalid billing policy for shop ${shopId}: ${detail}`,
  );
}

export const effectiveBillingPolicyResolver = new EffectiveBillingPolicyResolver();
