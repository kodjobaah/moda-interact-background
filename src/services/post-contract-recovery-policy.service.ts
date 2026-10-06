import {
  ProviderSubscriptionLifecycleState,
  SubscriptionProjectionStatus,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import prisma from "../lib/db.js";

export type PostContractRecoveryPolicy = {
  mode: "POST_CONTRACT_DURABLE_CREDITS";
  shopId: string;
  subscriptionId: string;
  subscriptionStatus: SubscriptionProjectionStatus;
  newRecoveriesPaused: boolean;
  automatedWhatsappPaused: boolean;
  outboundSoftLimit: number;
  outboundHardLimit: number;
  terminalMessageReservedSlots: number;
  billingPeriod: null;
};

export type PostContractRecoveryPolicyFailureReason =
  | "CONTRACT_REQUIRED"
  | "SHOP_UNAVAILABLE"
  | "INVALID_CONFIGURATION";

export class PostContractRecoveryPolicyError extends Error {
  constructor(
    public readonly reason: PostContractRecoveryPolicyFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "PostContractRecoveryPolicyError";
  }
}

type PostContractRecoveryPolicyClient = Pick<
  PrismaClient,
  "subscription" | "platformBillingPolicy" | "shopBillingPolicyOverride"
>;

export function isVerifiedEndedSubscription(input: {
  status: string;
  lastProviderLifecycleState?: string | null | undefined;
  onboardingCompleted?: boolean | undefined;
}): boolean {
  return (
    input.status === SubscriptionProjectionStatus.NO_CONTRACT &&
    input.lastProviderLifecycleState ===
      ProviderSubscriptionLifecycleState.CANCELED &&
    input.onboardingCompleted === true
  );
}

export class PostContractRecoveryPolicyResolver {
  constructor(
    private readonly client: PostContractRecoveryPolicyClient = prisma,
  ) {}

  async resolve(
    shopId: string,
    now = new Date(),
  ): Promise<PostContractRecoveryPolicy> {
    const subscription = await this.client.subscription.findUnique({
      where: { shopId },
      select: {
        id: true,
        status: true,
        lastProviderLifecycleState: true,
        shop: {
          select: {
            status: true,
            onboardingCompleted: true,
          },
        },
      },
    });

    if (!subscription || subscription.shop.status !== "ACTIVE") {
      throw new PostContractRecoveryPolicyError(
        "SHOP_UNAVAILABLE",
        `Shop ${shopId} is not active`,
      );
    }

    if (
      !isVerifiedEndedSubscription({
        status: subscription.status,
        lastProviderLifecycleState: subscription.lastProviderLifecycleState,
        onboardingCompleted: subscription.shop.onboardingCompleted,
      })
    ) {
      throw new PostContractRecoveryPolicyError(
        "CONTRACT_REQUIRED",
        `Shop ${shopId} is not an onboarded merchant with a verified ended subscription`,
      );
    }

    const [platformPolicy, override] = await Promise.all([
      this.client.platformBillingPolicy.findUnique({ where: { id: "default" } }),
      this.client.shopBillingPolicyOverride.findUnique({ where: { shopId } }),
    ]);

    if (!platformPolicy) {
      throw invalidConfiguration(shopId, "platform policy is missing");
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
    const terminalMessageReservedSlots = validateTerminalMessageReservedSlots(
      shopId,
      activeOverride?.terminalMessageReservedSlots ??
        platformPolicy.terminalMessageReservedSlots,
      limits.hard,
    );

    return {
      mode: "POST_CONTRACT_DURABLE_CREDITS",
      shopId,
      subscriptionId: subscription.id,
      subscriptionStatus: SubscriptionProjectionStatus.NO_CONTRACT,
      newRecoveriesPaused:
        platformPolicy.globalPauseNewRecoveries ||
        activeOverride?.pauseNewRecoveries === true,
      automatedWhatsappPaused:
        platformPolicy.globalPauseAutomatedWhatsapp ||
        activeOverride?.pauseAutomatedWhatsapp === true,
      outboundSoftLimit: limits.soft,
      outboundHardLimit: limits.hard,
      terminalMessageReservedSlots,
      billingPeriod: null,
    };
  }
}

function resolveOutboundLimits(
  shopId: string,
  platformSoft: number,
  platformDefaultHard: number,
  absoluteHard: number,
  override: {
    outboundSoftLimit: number | null;
    outboundHardLimit: number | null;
  } | null,
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
    throw invalidConfiguration(
      shopId,
      "platform soft limit exceeds platform hard limit",
    );
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
    throw invalidConfiguration(
      shopId,
      "shop soft limit exceeds shop hard limit",
    );
  }

  const hard = Math.min(overrideHard ?? validatedPlatformHard, validatedAbsoluteHard);
  const soft = Math.min(overrideSoft ?? validatedPlatformSoft, hard);
  if (soft < 1 || hard < 2 || soft > hard) {
    throw invalidConfiguration(shopId, "effective outbound limits are invalid");
  }
  return { soft, hard };
}

function validateMinimumInteger(
  shopId: string,
  label: string,
  value: number,
  minimum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw invalidConfiguration(
      shopId,
      `${label} must be a finite integer of at least ${minimum}`,
    );
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

function invalidConfiguration(
  shopId: string,
  detail: string,
): PostContractRecoveryPolicyError {
  return new PostContractRecoveryPolicyError(
    "INVALID_CONFIGURATION",
    `Invalid post-contract recovery policy for shop ${shopId}: ${detail}`,
  );
}

export const postContractRecoveryPolicyResolver =
  new PostContractRecoveryPolicyResolver();
