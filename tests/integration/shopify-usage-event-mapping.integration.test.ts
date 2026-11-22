import "dotenv/config";
import { randomUUID } from "node:crypto";
import { BillingPlanKind, MerchantPricingAllowancePeriod, MerchantPricingBillingPeriod, MerchantPricingPlanKind, MerchantPricingUsagePricingMode, PrismaClient, SubscriptionProjectionStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

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
        },
      });
      billingPlanId = billingPlan.id;
      const subscription = await db.subscription.create({
        data: { shopId, status: SubscriptionProjectionStatus.NO_CONTRACT },
      });
      subscriptionId = subscription.id;
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

      await db.$transaction(async (transaction) => {
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
      });

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
      await db.$transaction(async (transaction) => {
        const mapping = await resolveShopifyUsageEventMapping(transaction, billingPlan.shopifyPlanHandle, providerHandles);
        await transaction.subscription.update({
          where: { id: subscription.id },
          data: { unmappedShopifyUsageEventHandles: mapping.unmappedProviderHandles },
        });
      });

      const corrected = await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
      expect(corrected.status).toBe(SubscriptionProjectionStatus.ACTIVE);
      expect(corrected.planId).toBe(billingPlan.id);
      expect(corrected.billingPeriodId).toBe(period.id);
      expect(corrected.unmappedShopifyUsageEventHandles).toEqual([]);
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
