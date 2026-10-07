import { CheckoutRecoveryStatus, Prisma, UsageReservationStatus } from "@prisma/client";

import {
  EffectiveBillingPolicyError,
  EffectiveBillingPolicyResolver,
} from "../effective-billing-policy.service.js";
import type {
  BillingPolicyClient,
  EffectiveBillingPolicy,
} from "../effective-billing-policy.service.js";
import {
  PostContractRecoveryPolicyError,
  PostContractRecoveryPolicyResolver,
} from "../post-contract-recovery-policy.service.js";
import type { PostContractRecoveryPolicy } from "../post-contract-recovery-policy.service.js";
import type {
  OutboundAdmissionInput,
  OutboundAdmissionResult,
} from "./outbound-whatsapp-admission.types.js";

type PolicyResolverFactory = (
  client: BillingPolicyClient,
) => Pick<EffectiveBillingPolicyResolver, "resolve">;
type PostContractPolicyResolverFactory = (
  client: Prisma.TransactionClient,
) => Pick<PostContractRecoveryPolicyResolver, "resolve">;
type OutboundPolicy = EffectiveBillingPolicy | PostContractRecoveryPolicy;

type ConversationPolicyContext = {
  shopId: string | null;
  checkoutRecovery: { shopId: string; status: CheckoutRecoveryStatus } | null;
};

export type OutboundAdmissionPolicyResolution =
  | {
      kind: "resolved";
      policy: OutboundPolicy;
      executionScope: "general" | "recovery";
    }
  | Extract<OutboundAdmissionResult, { kind: "suppressed" }>;

export class OutboundAdmissionPolicyService {
  constructor(
    private readonly createPolicyResolver: PolicyResolverFactory,
    private readonly createPostContractPolicyResolver: PostContractPolicyResolverFactory,
  ) {}

  async resolve(
    transaction: Prisma.TransactionClient,
    input: OutboundAdmissionInput,
    conversation: ConversationPolicyContext,
  ): Promise<OutboundAdmissionPolicyResolution> {
    try {
      return {
        kind: "resolved",
        policy: await this.createPolicyResolver(transaction).resolve(input.shopId),
        executionScope: "general",
      };
    } catch (error) {
      if (
        error instanceof EffectiveBillingPolicyError &&
        error.reason === "NO_CONTRACT"
      ) {
        return this.resolvePostContract(transaction, input, conversation);
      }
      if (
        error instanceof EffectiveBillingPolicyError &&
        error.reason === "SUBSCRIPTION_FROZEN"
      ) {
        return { kind: "suppressed", reason: "subscription-frozen" };
      }
      throw error;
    }
  }

  private async resolvePostContract(
    transaction: Prisma.TransactionClient,
    input: OutboundAdmissionInput,
    conversation: ConversationPolicyContext,
  ): Promise<OutboundAdmissionPolicyResolution> {
    const continuingRecovery =
      conversation.checkoutRecovery !== null &&
      isContinuingRecoveryStatus(conversation.checkoutRecovery.status);
    const hasDurableReservation =
      input.recoveryCreditSourceKey !== undefined &&
      (await hasDurableRecoveryReservation(
        transaction,
        input.shopId,
        input.recoveryCreditSourceKey,
      ));
    if (
      !conversation.checkoutRecovery ||
      (!continuingRecovery && !hasDurableReservation)
    ) {
      return { kind: "suppressed", reason: "contract-required" };
    }

    try {
      return {
        kind: "resolved",
        policy: await this.createPostContractPolicyResolver(transaction).resolve(
          input.shopId,
        ),
        executionScope: "recovery",
      };
    } catch (error) {
      if (
        error instanceof PostContractRecoveryPolicyError &&
        (error.reason === "CONTRACT_REQUIRED" ||
          error.reason === "SHOP_UNAVAILABLE")
      ) {
        return { kind: "suppressed", reason: "contract-required" };
      }
      throw error;
    }
  }
}

function isContinuingRecoveryStatus(status: CheckoutRecoveryStatus): boolean {
  return (
    status === CheckoutRecoveryStatus.MESSAGE_SENT ||
    status === CheckoutRecoveryStatus.ENGAGED
  );
}

async function hasDurableRecoveryReservation(
  transaction: Prisma.TransactionClient,
  shopId: string,
  sourceKey: string,
): Promise<boolean> {
  const reservation = await transaction.usageReservation.findUnique({
    where: { sourceKey },
    select: {
      shopId: true,
      status: true,
      counter: { select: { counter: true } },
    },
  });
  return (
    reservation?.shopId === shopId &&
    reservation.status === UsageReservationStatus.RESERVED &&
    (reservation.counter?.counter === "PURCHASED_RECOVERY_CREDITS" ||
      reservation.counter?.counter === "LIFETIME_FREE_RECOVERY_CREDITS")
  );
}
