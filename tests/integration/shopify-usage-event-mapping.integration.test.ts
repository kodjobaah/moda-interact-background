import "dotenv/config";
import { randomUUID } from "node:crypto";
import { BillingPlanKind, MerchantPricingAllowancePeriod, MerchantPricingBillingPeriod, MerchantPricingPlanKind, MerchantPricingUsagePricingMode, PrismaClient, SubscriptionProjectionStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import type { PartnerSubscription } from "../../src/providers/shopify-partner-billing.provider.js";
import { GenericSubscriptionProjectionService } from "../../src/services/billing-reconciliation/generic-subscription-projection.service.js";
import { classifyObservedPlanProjection } from "../../src/services/billing-reconciliation/observed-plan-projection.js";
import { resolveShopifyUsageEventMapping } from "../../src/services/billing-reconciliation/shopify-usage-event-mapping.js";

const catalogueLocales = [
  "cs", "da", "de", "en", "es", "fi", "fr", "it", "ja", "ko", "nb", "nl", "pl",
  "pt-BR", "pt-PT", "sv", "th", "tr", "zh-Hans", "zh-Hant",
] as const;

const suite = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;

suite("Shopify provider-authoritative usage-event mapping PostgreSQL integration", () => {
  it("commits the unmapped handle array with the subscription projection and clears it after catalogue correction", async () => {
    const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
    const suffix = randomUUID();
    const shopId = `arch078-mapping-${suffix}`;
    const domain = `${shopId}.example.test`;
    let subscriptionId: string | undefined;
    let billingPeriodId: string | undefined;
    let billingPlanId: string | undefined;
    let merchantPricingPlanId: string | undefined;

    try {
      await db.shop.create({ data: { id: shopId, domain } });
      const billingPlan = await db.billingPlan.create({
        data: {
          shopifyPlanHandle: `paid-${suffix}`,
          name: "ARCH-078 mapping integration plan",
          kind: BillingPlanKind.PAID_METERED,
          includedRecoveryConversationAllowance: 100,
        },
      });
      billingPlanId = billingPlan.id;
      const subscription = await db.subscription.create({
        data: { shopId, status: SubscriptionProjectionStatus.NO_CONTRACT },
      });
      subscriptionId = subscription.id;
      // Keep the lifetime counter in place so real projection does not have
      // to rely on an unrelated global platform-policy fixture.
      await db.shopEntitlementCounter.create({
        data: { shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS", grantedQuantity: 2 },
      });
      const periodStart = new Date("2026-11-01T00:00:00.000Z");
      const periodEnd = new Date("2026-12-01T00:00:00.000Z");
      const period = await db.billingPeriod.create({
        data: {
          shopId,
          subscriptionId: subscription.id,
          planId: billingPlan.id,
          shopifyPlanHandleSnapshot: billingPlan.shopifyPlanHandle,
          planNameSnapshot: billingPlan.name,
          planKindSnapshot: BillingPlanKind.PAID_METERED,
          includedRecoveryCreditsGranted: 100,
          periodStart,
          periodEnd,
        },
      });
      billingPeriodId = period.id;
      const existingCataloguePlans = await db.merchantPricingPlan.findMany({
        select: { cataloguePosition: true },
        orderBy: { cataloguePosition: "asc" },
      });
      const cataloguePlan = await db.merchantPricingPlan.create({
        data: {
          shopifyPlanHandle: billingPlan.shopifyPlanHandle,
          displayName: "ARCH-078 mapping catalogue plan",
          planKind: MerchantPricingPlanKind.PAID_METERED,
          cataloguePosition: existingCataloguePlans.length,
          includedRecoveryCredits: 100,
          allowancePeriod: MerchantPricingAllowancePeriod.EVERY_30_DAYS,
          billingPeriod: MerchantPricingBillingPeriod.EVERY_30_DAYS,
          recurringAmountMinor: 1000,
          currency: "GBP",
          translations: {
            create: catalogueLocales.map((locale) => ({ locale, merchantDescription: "Mapping integration fixture" })),
          },
        },
      });
      merchantPricingPlanId = cataloguePlan.id;
      await db.merchantPricingUsageEvent.create({
        data: {
          merchantPricingPlanId: cataloguePlan.id,
          eventHandle: "known-event",
          adminLabel: "Known event",
          creditsGrantedPerUnit: 1,
          position: 0,
          pricingMode: MerchantPricingUsagePricingMode.FIXED,
          currency: "GBP",
          fixedUnitAmountMinor: 10,
        },
      });

      const providerHandles = ["known-event", "new-event", "new-event"];
      const provider: PartnerSubscription = {
        planHandle: billingPlan.shopifyPlanHandle,
        usageEventHandles: providerHandles,
        pendingPlanHandle: null,
        pendingEffectiveAt: null,
        status: "ACTIVE",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        providerSubscriptionId: `provider-${suffix}`,
        providerUsageSnapshot: [],
        providerUsagePricingSnapshot: [],
      };
      const scheduler = { enqueue: vi.fn(async () => undefined) };
      const reconciliation = new GenericSubscriptionProjectionService(
        db, scheduler as never, { warn: vi.fn() } as never,
      );
      const failedProjection = new Error("rollback projection after mapping update");
      await expect(db.$transaction(async (transaction) => {
        const mapping = await resolveShopifyUsageEventMapping(transaction, billingPlan.shopifyPlanHandle, providerHandles);
        await transaction.subscription.update({
          where: { id: subscription.id },
          data: {
            status: SubscriptionProjectionStatus.ACTIVE,
            planId: billingPlan.id,
            billingPeriodId: period.id,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            observedShopifyPlanHandle: billingPlan.shopifyPlanHandle,
            unmappedShopifyUsageEventHandles: mapping.unmappedProviderHandles,
          },
        });
        throw failedProjection;
      })).rejects.toBe(failedProjection);

      const rolledBack = await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
      expect(rolledBack.status).toBe(SubscriptionProjectionStatus.NO_CONTRACT);
      expect(rolledBack.planId).toBeNull();
      expect(rolledBack.billingPeriodId).toBeNull();
      expect(rolledBack.currentPeriodStart).toBeNull();
      expect(rolledBack.currentPeriodEnd).toBeNull();
      expect(rolledBack.unmappedShopifyUsageEventHandles).toEqual([]);

      // Exercise the production service: the plan, period and mapping must be
      // committed by the same reconciliation transaction.
      const firstProjection = await reconciliation.reconcile({
        shopId,
        provider,
        plan: billingPlan,
        existing: null,
        projection: classifyObservedPlanProjection(provider, billingPlan),
        now: new Date("2026-11-15T00:00:00.000Z"),
      });
      expect(firstProjection.billingPeriodId).toBe(period.id);
      expect(scheduler.enqueue).not.toHaveBeenCalled();

      const projected = await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
      expect(projected.status).toBe(SubscriptionProjectionStatus.ACTIVE);
      expect(projected.planId).toBe(billingPlan.id);
      expect(projected.billingPeriodId).toBe(period.id);
      expect(projected.unmappedShopifyUsageEventHandles).toEqual(["new-event"]);

      await db.merchantPricingUsageEvent.create({
        data: {
          merchantPricingPlanId: cataloguePlan.id,
          eventHandle: "new-event",
          adminLabel: "New event after Admin correction",
          creditsGrantedPerUnit: 1,
          position: 1,
          pricingMode: MerchantPricingUsagePricingMode.FIXED,
          currency: "GBP",
          fixedUnitAmountMinor: 20,
        },
      });
      // A second real observation after Admin catalogue correction clears the
      // unmapped array without disturbing the persisted plan or billing period.
      await reconciliation.reconcile({
        shopId,
        provider,
        plan: billingPlan,
        existing: projected,
        projection: classifyObservedPlanProjection(provider, billingPlan),
        now: new Date("2026-11-15T00:01:00.000Z"),
      });

      const corrected = await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
      expect(corrected.status).toBe(SubscriptionProjectionStatus.ACTIVE);
      expect(corrected.planId).toBe(billingPlan.id);
      expect(corrected.billingPeriodId).toBe(period.id);
      expect(corrected.unmappedShopifyUsageEventHandles).toEqual([]);
      expect(scheduler.enqueue).not.toHaveBeenCalled();
    } finally {
      if (billingPeriodId) await db.billingPeriod.deleteMany({ where: { id: billingPeriodId } });
      if (subscriptionId) await db.subscription.deleteMany({ where: { id: subscriptionId } });
      if (merchantPricingPlanId) await db.merchantPricingPlan.deleteMany({ where: { id: merchantPricingPlanId } });
      if (billingPlanId) await db.billingPlan.deleteMany({ where: { id: billingPlanId } });
      await db.shop.deleteMany({ where: { id: shopId } });
      await db.$disconnect();
    }
  }, 45_000);
});
