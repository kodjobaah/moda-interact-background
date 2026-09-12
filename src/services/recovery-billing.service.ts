import {
  ARCH007_BILLING_CONTRACT_SCHEMA_VERSION,
  BILLING_SYSTEM_MESSAGE_CODES,
  createMerchantBillingSystemSourceKey,
  createRecoveryIdempotencyKey,
  createShopifyUsageIdempotencyKey,
} from "@modainteract/moda-interact-shared/billing";
import {
  MerchantSupportMessageKind,
  MerchantSupportMessageState,
  ShopifyReportState,
  UsageMetric,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import prisma from "../lib/db.js";
import {
  effectiveBillingPolicyResolver,
  type EffectiveBillingPolicy,
} from "./effective-billing-policy.service.js";
import {
  freeRecoveryReservationService,
  type FreeRecoveryReservationInput,
} from "./free-recovery-reservation.service.js";
import {
  purchasedRecoveryReservationService,
  type PurchasedRecoveryReservationInput,
} from "./purchased-recovery-reservation.service.js";

type RecoveryBillingDatabase = Pick<
  PrismaClient,
  "$transaction" | "usageEvent" | "merchantSupportThread" | "merchantSupportMessage"
>;

type RecoveryPolicyResolver = Pick<typeof effectiveBillingPolicyResolver, "resolve">;
type FreeReservationService = Pick<
  typeof freeRecoveryReservationService,
  "reserve" | "commit" | "release" | "markAmbiguous"
>;
type PurchasedReservationService = Pick<
  typeof purchasedRecoveryReservationService,
  "reserve" | "commit" | "release" | "markAmbiguous"
>;

export type RecoveryBillingAdmission =
  | {
      kind: "free";
      sourceKey: string;
      policy: EffectiveBillingPolicy;
    }
  | {
      kind: "paid";
      sourceKey: string;
      policy: EffectiveBillingPolicy;
    }
  | {
      kind: "purchased";
      sourceKey: string;
      policy: EffectiveBillingPolicy;
    }
  | {
      kind: "lifetime-free";
      sourceKey: string;
      policy: EffectiveBillingPolicy;
    };

export type RecoveryBillingAdmissionResult =
  | { kind: "admitted"; admission: RecoveryBillingAdmission }
  | {
      kind: "blocked";
      reason: "paused" | "allowance-exhausted" | "reservation-in-flight";
    };

export type RecoveryProviderFailureDisposition = "definitive" | "ambiguous";

export class RecoveryBillingService {
  constructor(
    private readonly database: RecoveryBillingDatabase = prisma,
    private readonly policyResolver: RecoveryPolicyResolver = effectiveBillingPolicyResolver,
    private readonly reservationService: FreeReservationService = freeRecoveryReservationService,
    private readonly purchasedReservationService: PurchasedReservationService = purchasedRecoveryReservationService,
  ) {}

  async admit(input: {
    shopId: string;
    recoveryId: string;
  }): Promise<RecoveryBillingAdmissionResult> {
    const policy = await this.policyResolver.resolve(input.shopId);
    const sourceKey = createRecoveryIdempotencyKey(input.shopId, input.recoveryId);

    if (policy.newRecoveriesPaused) {
      return { kind: "blocked", reason: "paused" };
    }

    if (policy.planKind === "PAID_METERED") {
      if (!paidIncludedCapacityExhausted(policy)) {
        return { kind: "admitted", admission: { kind: "paid", sourceKey, policy } };
      }
      const purchased = await this.tryPurchasedAdmission(input.shopId, sourceKey, policy, true);
      if (purchased) return purchased;
      const lifetimeFree = await this.tryLifetimeFreeAdmission(input.shopId, sourceKey, policy);
      if (lifetimeFree) return lifetimeFree;
      return { kind: "blocked", reason: "allowance-exhausted" };
    }

    const purchased = await this.tryPurchasedAdmission(input.shopId, sourceKey, policy, false);
    if (purchased) return purchased;
    const lifetimeFree = await this.tryLifetimeFreeAdmission(input.shopId, sourceKey, policy);
    if (lifetimeFree) return lifetimeFree;
    await this.createCapacityExhaustedMessage(input.shopId, policy);
    return { kind: "blocked", reason: "allowance-exhausted" };
  }

  async commitSuccessfulInitiation(input: {
    admission: RecoveryBillingAdmission;
    recoveryId: string;
    occurredAt: Date;
  }): Promise<void> {
    if (input.admission.kind === "free" || input.admission.kind === "lifetime-free") {
      await this.reservationService.commit({
        shopId: input.admission.policy.shopId,
        sourceKey: input.admission.sourceKey,
      });
      return;
    }

    if (input.admission.kind === "purchased") {
      await this.purchasedReservationService.commit({
        shopId: input.admission.policy.shopId,
        sourceKey: input.admission.sourceKey,
      });
      return;
    }

    const idempotencyKey = createRecoveryIdempotencyKey(
      input.admission.policy.shopId,
      input.recoveryId,
    );
    await this.database.usageEvent.upsert({
      where: { idempotencyKey },
      create: {
        shopId: input.admission.policy.shopId,
        billingPeriodId: input.admission.policy.billingPeriod?.id ?? null,
        metric: UsageMetric.RECOVERY_CONVERSATION,
        quantity: 1,
        idempotencyKey,
        sourceType: "PAID_RECOVERY_CONVERSATION",
        sourceId: input.recoveryId,
        occurredAt: input.occurredAt,
        shopifyReportState: ShopifyReportState.PENDING,
        shopifyEventHandle: input.admission.policy.shopifyUsageEventHandle,
        shopifyIdempotencyKey: createShopifyUsageIdempotencyKey(
          input.admission.policy.shopId,
          idempotencyKey,
        ),
      },
      update: {},
    });
  }

  async handleProviderFailure(input: {
    admission: RecoveryBillingAdmission;
    error: unknown;
  }): Promise<RecoveryProviderFailureDisposition> {
    const disposition = isDefinitiveProviderFailure(input.error)
      ? "definitive"
      : "ambiguous";

    if (input.admission.kind === "purchased") {
      const reservationInput = {
        shopId: input.admission.policy.shopId,
        sourceKey: input.admission.sourceKey,
      };
      if (disposition === "definitive") {
        await this.purchasedReservationService.release(reservationInput);
      } else {
        await this.purchasedReservationService.markAmbiguous(reservationInput);
      }
      return disposition;
    }

    if (input.admission.kind !== "free" && input.admission.kind !== "lifetime-free") return disposition;

    const reservationInput = {
      shopId: input.admission.policy.shopId,
      sourceKey: input.admission.sourceKey,
    };

    if (disposition === "definitive") {
      await this.reservationService.release(reservationInput);
      return disposition;
    }

    await this.reservationService.markAmbiguous(reservationInput);
    return disposition;
  }

  async releaseBeforeProvider(admission: RecoveryBillingAdmission): Promise<void> {
    if (admission.kind === "purchased") {
      await this.purchasedReservationService.release({
        shopId: admission.policy.shopId,
        sourceKey: admission.sourceKey,
      });
      return;
    }
    if (admission.kind !== "free" && admission.kind !== "lifetime-free") return;
    await this.reservationService.release({
      shopId: admission.policy.shopId,
      sourceKey: admission.sourceKey,
    });
  }

  private async tryPurchasedAdmission(
    shopId: string,
    sourceKey: string,
    policy: EffectiveBillingPolicy,
    paid: boolean,
  ): Promise<RecoveryBillingAdmissionResult | null> {
    const pack = policy.recoveryCreditPack;
    if (!pack?.enabled) return null;
    if (paid) {
      if (
        pack.includedRecoveryConversationAllowance === null ||
        pack.normalRecoveryUsageQuantity === null ||
        pack.normalRecoveryUsageQuantity < pack.includedRecoveryConversationAllowance
      ) {
        return null;
      }
    }

    const reservationInput: PurchasedRecoveryReservationInput = {
      shopId,
      sourceKey: purchasedReservationSourceKey(sourceKey),
    };
    const reservation = await this.purchasedReservationService.reserve(reservationInput);
    if (reservation.kind === "reserved") {
      return {
        kind: "admitted",
        admission: {
          kind: "purchased",
          sourceKey: reservationInput.sourceKey,
          policy,
        },
      };
    }
    if (reservation.kind === "credits-exhausted") return null;
    return { kind: "blocked", reason: "reservation-in-flight" };
  }

  private async tryLifetimeFreeAdmission(
    shopId: string,
    sourceKey: string,
    policy: EffectiveBillingPolicy,
  ): Promise<RecoveryBillingAdmissionResult | null> {
    const reservation = await this.reservationService.reserve({
      shopId,
      sourceKey,
    });
    if (reservation.kind === "reserved") {
      return {
        kind: "admitted",
        admission: { kind: "lifetime-free", sourceKey, policy },
      };
    }
    if (reservation.kind === "allowance-exhausted") return null;
    if (reservation.kind === "paused") return { kind: "blocked", reason: "paused" };
    return { kind: "blocked", reason: "reservation-in-flight" };
  }

  private async createCapacityExhaustedMessage(
    shopId: string,
    policy: EffectiveBillingPolicy,
  ): Promise<void> {
    const systemCode = BILLING_SYSTEM_MESSAGE_CODES.RECOVERY_CAPACITY_EXHAUSTED;
    const exhaustionLifecycle = `capacity-exhausted:free-allowance:${policy.subscriptionId}:${policy.freeAllowance!.effective}`;
    const sourceKey = createMerchantBillingSystemSourceKey(
      shopId,
      systemCode,
      exhaustionLifecycle,
      ARCH007_BILLING_CONTRACT_SCHEMA_VERSION,
    );
    const now = new Date();

    await this.database.$transaction(async (transaction) => {
      const thread = await transaction.merchantSupportThread.upsert({
        where: { shopId },
        create: { shopId },
        update: {},
      });

      await transaction.merchantSupportMessage.upsert({
        where: { sourceKey },
        create: {
          threadId: thread.id,
          kind: MerchantSupportMessageKind.SYSTEM,
          state: MerchantSupportMessageState.AVAILABLE,
          originalBody:
            "Your recovery capacity has been used. Choose a paid plan to start new recovery conversations.",
          sourceLanguageTag: "en-GB",
          systemCode,
          systemVersion: String(ARCH007_BILLING_CONTRACT_SCHEMA_VERSION),
          sourceKey,
          availableAt: now,
        },
        update: {},
      });

      await transaction.merchantSupportThread.update({
        where: { id: thread.id },
        data: { lastMessageAt: now },
      });
    });
  }
}

function purchasedReservationSourceKey(sourceKey: string): string {
  return `purchased:${sourceKey}`;
}

function paidIncludedCapacityExhausted(policy: EffectiveBillingPolicy): boolean {
  const pack = policy.recoveryCreditPack;
  return Boolean(
    pack?.enabled &&
      pack.includedRecoveryConversationAllowance !== null &&
      pack.normalRecoveryUsageQuantity !== null &&
      pack.normalRecoveryUsageQuantity >= pack.includedRecoveryConversationAllowance,
  );
}

function isDefinitiveProviderFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "WhatsAppServiceError" &&
    "code" in error &&
    (error.code === "configuration-missing" || error.code === "provider-rejected")
  );
}

export const recoveryBillingService = new RecoveryBillingService();