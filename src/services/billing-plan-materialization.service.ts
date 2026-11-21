import {
  BillingPlanKind,
  MerchantPricingPlanKind,
  MerchantPricingPlanPublicationStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";

// One authoritative catalogue -> operational mapping. Shopify handles are immutable identities:
// a different handle creates a new plan, never an update to an existing operational plan.
const operationalPlanSelect = {
  id: true,
  active: true,
  name: true,
  kind: true,
  shopifyPlanHandle: true,
  shopifyUsageEventHandle: true,
  shopifyRecoveryCreditPackEventHandle: true,
  recoveryCreditPackEnabled: true,
  includedRecoveryConversationAllowance: true,
} satisfies Prisma.BillingPlanSelect;

export type ResolvedBillingPlan = Prisma.BillingPlanGetPayload<{ select: typeof operationalPlanSelect }>;

type MaterializationDatabase = Pick<PrismaClient, "billingPlan" | "merchantPricingPlan" | "$transaction">;

export class BillingPlanMaterializationService {
  constructor(
    private readonly database: MaterializationDatabase,
    private readonly logger: StructuredLogger = createLogger({
      serviceName: "moda-billing-worker",
      environment: resolveDeploymentEnvironmentName(),
    }),
  ) {}

  async resolve(shopifyPlanHandle: string): Promise<ResolvedBillingPlan | null> {
    // No normalization or aliases: historic Shopify contracts must keep their own plan.
    const existing = await this.database.billingPlan.findUnique({
      where: { shopifyPlanHandle },
      select: operationalPlanSelect,
    });
    if (existing) return existing;
    return this.materializeIfMissing(shopifyPlanHandle);
  }

  /** Called only after a caller has already observed a missing operational plan. */
  async materializeIfMissing(shopifyPlanHandle: string): Promise<ResolvedBillingPlan | null> {
    try {
      const result = await this.database.$transaction(async (transaction) => {
        // A concurrent worker may have created the plan since the initial lookup.
        const materialized = await transaction.billingPlan.findUnique({
          where: { shopifyPlanHandle },
          select: operationalPlanSelect,
        });
        if (materialized) return { created: false as const, plan: materialized };

        const catalogue = await transaction.merchantPricingPlan.findUnique({
          where: { shopifyPlanHandle },
          select: {
            id: true,
            isActive: true,
            publicationStatus: true,
            displayName: true,
            planKind: true,
            includedRecoveryCredits: true,
            shopifyRecoveryUsageEventHandle: true,
            features: { select: { featureId: true, configuration: true } },
          },
        });
        // Catalogue mapping defects are UNMAPPED, not provider synchronisation failures.
        // Keep the reason for diagnostics; the caller owns subscription status projection.
        if (!catalogue) return { created: false as const, plan: null, unavailableReason: "CATALOGUE_MISSING" };
        if (!catalogue.isActive) return { created: false as const, plan: null, unavailableReason: "CATALOGUE_INACTIVE" };
        if (catalogue.publicationStatus !== MerchantPricingPlanPublicationStatus.READY) {
          return { created: false as const, plan: null, unavailableReason: "CATALOGUE_NOT_READY" };
        }
        if (!Number.isSafeInteger(catalogue.includedRecoveryCredits) || catalogue.includedRecoveryCredits < 0) {
          return { created: false as const, plan: null, unavailableReason: "INVALID_INCLUDED_RECOVERY_CREDITS" };
        }
        if (catalogue.planKind === MerchantPricingPlanKind.FREE && catalogue.shopifyRecoveryUsageEventHandle !== null) {
          return { created: false as const, plan: null, unavailableReason: "FREE_PLAN_HAS_RECOVERY_USAGE_METER" };
        }
        if (catalogue.planKind === MerchantPricingPlanKind.PAID_METERED
          && !catalogue.shopifyRecoveryUsageEventHandle?.trim()) {
          return { created: false as const, plan: null, unavailableReason: "PAID_PLAN_MISSING_RECOVERY_USAGE_METER" };
        }
        const kind = catalogue.planKind === MerchantPricingPlanKind.FREE
          ? BillingPlanKind.FREE
          : BillingPlanKind.PAID_METERED;
        const plan = await transaction.billingPlan.create({
          data: {
            shopifyPlanHandle,
            name: catalogue.displayName,
            kind,
            active: true,
            // This is the ordinary recovery usage meter, NOT a purchased credit-pack
            // offer. Top-up bundles use MerchantPricingPlan.usageEvents independently.
            shopifyUsageEventHandle: kind === BillingPlanKind.PAID_METERED
              ? catalogue.shopifyRecoveryUsageEventHandle!.trim()
              : null,
            includedRecoveryConversationAllowance: kind === BillingPlanKind.PAID_METERED
              ? catalogue.includedRecoveryCredits
              : null,
            recoveryCreditPackEnabled: false,
            recoveryCreditsPerPack: null,
            shopifyRecoveryCreditPackEventHandle: null,
            features: {
              create: catalogue.features.map((feature) => ({
                featureId: feature.featureId,
                enabled: true,
                configuration: feature.configuration === null
                  ? Prisma.JsonNull
                  : feature.configuration as Prisma.InputJsonValue,
              })),
            },
          },
          select: operationalPlanSelect,
        });
        await transaction.merchantPricingPlan.update({
          where: { id: catalogue.id },
          data: { materializedAt: new Date() },
        });
        return { created: true as const, plan };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      if (result.created && result.plan) {
        this.logger.info("billing.plan_materialized", {
          shopifyPlanHandle,
          billingPlanId: result.plan.id,
          billingPlanKind: result.plan.kind,
        });
      } else if (!result.plan) {
        this.logger.warn("billing.plan_catalogue_unavailable", {
          shopifyPlanHandle,
          unavailableReason: "unavailableReason" in result ? result.unavailableReason : "UNKNOWN",
        });
      }
      return result.plan;
    } catch (error) {
      // P2002: another worker won the unique handle; P2034: serializable race.
      // Return only a committed winner; otherwise preserve the original Prisma error.
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034")) {
        const winner = await this.database.billingPlan.findUnique({
          where: { shopifyPlanHandle },
          select: operationalPlanSelect,
        });
        if (winner) return winner;
      }
      this.logger.error("billing.plan_materialization_failed", {
        shopifyPlanHandle,
        errorMessage: error instanceof Error ? error.message : String(error),
        error,
      });
      throw error;
    }
  }
}
