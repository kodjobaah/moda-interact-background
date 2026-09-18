import {
  BillingPeriodEntitlementCounterKind,
  BillingPeriodStatus,
  BillingPlanKind,
  SubscriptionProjectionStatus,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS } from "@modainteract/moda-interact-shared/billing";
import prisma from "../lib/db.js";

export type BillingPolicyFailureReason =
  | "NO_CONTRACT"
  | "SUBSCRIPTION_FROZEN"
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
  shopId: string;
  subscriptionId: string;
  start: Date;
  end: Date;
  status: BillingPeriodStatus;
  phase: "ACTIVE" | "DRAINING" | "EXPIRED_RECONCILING";
  includedCounter: {
    id: string;
    shopId: string;
    billingPeriodId: string;
    grantedQuantity: number;
    committedQuantity: number;
    reservedQuantity: number;
    forfeitedQuantity: number;
  };
};

export type RecoveryCreditPackPolicy = {
  enabled: boolean;
  creditsPerPack: number;
  shopifyEventHandle: string;
  includedRecoveryConversationAllowance: number | null;
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
  features: ReadonlySet<string>;
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
  | "shopFeaturePreference"
  | "billingPeriodEntitlementCounter"
>;

const activeSubscriptionStatuses: SubscriptionProjectionStatus[] = [
  SubscriptionProjectionStatus.ACTIVE,
  SubscriptionProjectionStatus.TRIALING,
];

export class EffectiveBillingPolicyResolver {
  constructor(private readonly client: BillingPolicyClient = prisma) {}

  async resolve(
    shopId: string,
    now = new Date(),
  ): Promise<EffectiveBillingPolicy> {
    const subscription = await this.client.subscription.findUnique({
      where: { shopId },
      include: {
        plan: { include: { features: { include: { feature: true } } } },
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

    if (subscription.status === SubscriptionProjectionStatus.FROZEN) {
      throw new EffectiveBillingPolicyError(
        "SUBSCRIPTION_FROZEN",
        `Shop ${shopId} subscription is frozen`,
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

    const [platformPolicy, override, counter, shopFeaturePreferences] = await Promise.all([
      this.client.platformBillingPolicy.findUnique({ where: { id: "default" } }),
      this.client.shopBillingPolicyOverride.findUnique({ where: { shopId } }),
      this.client.shopEntitlementCounter.findUnique({
        where: {
          shopId_counter: { shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" },
        },
        select: { grantedQuantity: true, committedQuantity: true, reservedQuantity: true },
      }),
      this.client.shopFeaturePreference.findMany({
        where: { shopId },
        include: { feature: true },
      }),
    ]);

    if (!platformPolicy) {
      throw invalidConfiguration(shopId, "platform policy is missing");
    }
    if (!counter) {
      throw invalidConfiguration(shopId, "lifetime Free recovery counter is missing");
    }

    const billingPeriodCounter =
      plan.kind === BillingPlanKind.PAID_METERED && subscription.billingPeriod
        ? await this.client.billingPeriodEntitlementCounter.findUnique({
            where: {
              billingPeriodId_counter: {
                billingPeriodId: subscription.billingPeriod.id,
                counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
              },
            },
          })
        : null;

    if (plan.kind === BillingPlanKind.PAID_METERED) {
      validatePaidBillingPeriod(shopId, subscription, billingPeriodCounter, now);
    }

    const activeOverride =
      override && (override.expiresAt === null || override.expiresAt > now)
        ? override
        : null;

    const limits = resolveOutboundLimits(
      shopId,
      platformPolicy.defaultOutboundSoftLimit,
      platformPolicy.defaultOutboundHardLimit,
      platformPolicy.absoluteOutboundHardLimit,
      activeOverride,
    );

    const optedInFeatureKeys = new Set(
      shopFeaturePreferences
        .filter((preference) => preference.enabled)
        .map((preference) => preference.feature.key),
    );
    const features = new Set<string>();
    for (const mapping of plan.features) {
      if (!mapping.enabled || !mapping.feature.active) continue;
      if (mapping.feature.activationMode === "ALWAYS_ENABLED") {
        features.add(mapping.feature.key);
        continue;
      }
      if (
        mapping.feature.activationMode === "MERCHANT_OPT_IN" &&
        optedInFeatureKeys.has(mapping.feature.key)
      ) {
        features.add(mapping.feature.key);
      }
    }

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
    const recoveryCreditPack = packConfiguration
      ? {
          ...packConfiguration,
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
      activeOverride?.terminalMessageReservedSlots ??
        platformPolicy.terminalMessageReservedSlots,
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
              shopId: subscription.billingPeriod.shopId,
              subscriptionId: subscription.billingPeriod.subscriptionId,
              start: subscription.billingPeriod.periodStart,
              end: subscription.billingPeriod.periodEnd,
              status: subscription.billingPeriod.status,
              phase: getBillingPeriodPhase(subscription.billingPeriod.periodEnd, now),
              includedCounter: {
                id: billingPeriodCounter!.id,
                shopId: billingPeriodCounter!.shopId,
                billingPeriodId: billingPeriodCounter!.billingPeriodId,
                grantedQuantity: billingPeriodCounter!.grantedQuantity,
                committedQuantity: billingPeriodCounter!.committedQuantity,
                reservedQuantity: billingPeriodCounter!.reservedQuantity,
                forfeitedQuantity: billingPeriodCounter!.forfeitedQuantity,
              },
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
): Omit<RecoveryCreditPackPolicy, "includedRecoveryConversationAllowance"> | null {
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
  if (committedValue + reservedValue > grantValue) {
    throw invalidConfiguration(
      shopId,
      "committed and reserved lifetime Free credits exceed the lifetime Free grant",
    );
  }

  return {
    grant: grantValue,
    effective: grantValue,
    committed: committedValue,
    reserved: reservedValue,
    remaining: grantValue - committedValue - reservedValue,
  };
}

function validatePaidBillingPeriod(
  shopId: string,
  subscription: {
    id: string;
    billingPeriodId: string | null;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    billingPeriod: {
      id: string;
      shopId: string;
      subscriptionId: string;
      periodStart: Date;
      periodEnd: Date;
      status: BillingPeriodStatus;
    } | null;
  },
  counter: {
    id: string;
    shopId: string;
    billingPeriodId: string;
    grantedQuantity: number;
    committedQuantity: number;
    reservedQuantity: number;
    forfeitedQuantity: number;
  } | null,
  now: Date,
): void {
  const period = subscription.billingPeriod;
  if (
    !subscription.billingPeriodId ||
    !period ||
    !subscription.currentPeriodStart ||
    !subscription.currentPeriodEnd ||
    period.id !== subscription.billingPeriodId ||
    period.shopId !== shopId ||
    period.subscriptionId !== subscription.id ||
    period.status !== BillingPeriodStatus.OPEN ||
    period.periodStart.getTime() !== subscription.currentPeriodStart.getTime() ||
    period.periodEnd.getTime() !== subscription.currentPeriodEnd.getTime()
  ) {
    throw invalidConfiguration(shopId, "paid billing period projection is missing or inconsistent");
  }

  if (!counter || counter.shopId !== shopId || counter.billingPeriodId !== period.id) {
    throw invalidConfiguration(shopId, "paid included recovery counter is missing or inconsistent");
  }
  for (const value of [
    counter.grantedQuantity,
    counter.committedQuantity,
    counter.reservedQuantity,
    counter.forfeitedQuantity,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw invalidConfiguration(shopId, "paid included recovery counter quantities are invalid");
    }
  }
  if (
    counter.committedQuantity + counter.reservedQuantity + counter.forfeitedQuantity >
    counter.grantedQuantity
  ) {
    throw invalidConfiguration(shopId, "paid included recovery counter quantities exceed the grant");
  }
}

function getBillingPeriodPhase(
  periodEnd: Date,
  now: Date,
): "ACTIVE" | "DRAINING" | "EXPIRED_RECONCILING" {
  if (now.getTime() >= periodEnd.getTime()) return "EXPIRED_RECONCILING";
  if (
    now.getTime() >=
    periodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS
  ) {
    return "DRAINING";
  }
  return "ACTIVE";
}

function resolveOutboundLimits(
  shopId: string,
  platformSoft: number,
  platformDefaultHard: number,
  absoluteHard: number,
  override: { outboundSoftLimit: number | null; outboundHardLimit: number | null } | null,
): { soft: number; hard: number } {
  const validatedPlatformSoft = validateMinimumInteger(
    shopId,
    "platform soft limit",
    platformSoft,
    1,
  );
  const validatedPlatformHard = validateMinimumInteger(
    shopId,
    "platform default hard limit",
    platformDefaultHard,
    2,
  );
  const validatedAbsoluteHard = validateMinimumInteger(
    shopId,
    "platform absolute hard limit",
    absoluteHard,
    2,
  );
  if (validatedPlatformSoft > validatedPlatformHard) {
    throw invalidConfiguration(shopId, "platform soft limit exceeds platform hard limit");
  }

  const overrideHard = override?.outboundHardLimit;
  const overrideSoft = override?.outboundSoftLimit;
  if (overrideHard !== null && overrideHard !== undefined) {
    validateMinimumInteger(shopId, "shop hard limit", overrideHard, 2);
  }
  if (overrideSoft !== null && overrideSoft !== undefined) {
    validateMinimumInteger(shopId, "shop soft limit", overrideSoft, 1);
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

  const requestedHardLimit = overrideHard ?? validatedPlatformHard;
  const hard = Math.min(requestedHardLimit, validatedAbsoluteHard);
  const requestedSoftLimit = overrideSoft ?? validatedPlatformSoft;
  const soft = Math.min(requestedSoftLimit, hard);
  if (soft < 1 || hard < 2 || soft > hard) {
    throw invalidConfiguration(shopId, "effective outbound limits are invalid");
  }
  return { soft, hard };
}

function validatePositiveInteger(shopId: string, label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidConfiguration(shopId, `${label} must be a finite positive integer`);
  }
  return value;
}

function validateMinimumInteger(
  shopId: string,
  label: string,
  value: number,
  minimum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw invalidConfiguration(shopId, `${label} must be a finite integer of at least ${minimum}`);
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
