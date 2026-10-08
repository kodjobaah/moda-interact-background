import {
  ProviderSubscriptionLifecycleState,
  SubscriptionProjectionStatus,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import prisma from "../lib/db.js";
import {
  resolveOutboundLimits,
  validateTerminalMessageReservedSlots,
} from "./billing-policy/outbound-limits.js";

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
      invalidConfiguration,
    );
    const terminalMessageReservedSlots = validateTerminalMessageReservedSlots(
      shopId,
      activeOverride?.terminalMessageReservedSlots ??
        platformPolicy.terminalMessageReservedSlots,
      limits.hard,
      invalidConfiguration,
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
