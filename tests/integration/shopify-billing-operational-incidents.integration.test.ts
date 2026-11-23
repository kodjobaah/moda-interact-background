import "dotenv/config";
import { randomUUID } from "node:crypto";
import { BillingPlanKind, PrismaClient, SubscriptionProjectionStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  createOperationalIncidentReporter,
  createPrismaOperationalIncidentPersistence,
} from "@modainteract/moda-interact-shared/incidents";
import { createBillingIncidentSink } from "../../src/services/billing-operational-incident.service.js";
import { BillingReconciliationSchedulerService } from "../../src/services/billing-reconciliation/reconciliation-scheduler.service.js";
import { GenericSubscriptionProjectionService } from "../../src/services/billing-reconciliation/generic-subscription-projection.service.js";
import { classifyObservedPlanProjection } from "../../src/services/billing-reconciliation/observed-plan-projection.js";
import type { PartnerSubscription } from "../../src/providers/shopify-partner-billing.provider.js";

const suite = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;

suite("Shopify billing incident delivery to existing Admin incident store", () => {
  it("persists one actionable incident and deduplicates a repeated committed failure", async () => {
    const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
    const shopId = `billing-incident-${randomUUID()}`;
    try {
      await db.shop.create({ data: { id: shopId, domain: `${shopId}.example.test` } });
      const subscription = await db.subscription.create({ data: {
        shopId, status: SubscriptionProjectionStatus.SYNC_ERROR,
        observedShopifyPlanHandle: "growth",
        lastSyncErrorCode: "UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT",
        lastSyncErrorAt: new Date("2026-11-22T12:00:00Z"),
      } });
      const logger = { error: () => undefined };
      const reporter = createOperationalIncidentReporter({
        persistence: createPrismaOperationalIncidentPersistence({ prisma: db }),
        logger: logger as never,
        notifySupport: false,
      });
      const sink = createBillingIncidentSink(reporter, logger as never, "test");
      await sink.report(shopId, subscription);
      await sink.report(shopId, subscription);

      const records = await db.operationalIncident.findMany({ where: {
        shopId, category: "SHOPIFY_SUBSCRIPTION_BILLING",
      }, include: { events: true } });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        reasonCode: "UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT",
        resourceKey: subscription.id,
        severity: "HIGH",
        status: "OPEN",
      });
      expect(records[0]!.lastErrorMessage).toContain("Repair only from verified records");
      expect(records[0]!.occurrenceCount).toBe(1);
    } finally {
      // OperationalIncidentEvent is append-only. The integration runner owns a
      // disposable PostgreSQL database and removes it after the test process;
      // do not delete audit history (or its referenced shop/subscription) here.
      await db.$disconnect();
    }
  }, 45_000);

  it("delivers a real committed missing-cycle reconciliation failure to Admin without a direct sink call", async () => {
    const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
    const suffix = randomUUID();
    const shopId = `billing-failure-${suffix}`;
    try {
      await db.shop.create({ data: { id: shopId, domain: `${shopId}.example.test` } });
      const plan = await db.billingPlan.create({ data: {
        shopifyPlanHandle: `growth-${suffix}`,
        name: "Missing-cycle incident test plan",
        kind: BillingPlanKind.PAID_METERED,
        includedRecoveryConversationAllowance: 100,
      } });
      const subscription = await db.subscription.create({
        data: { shopId, status: SubscriptionProjectionStatus.NO_CONTRACT },
      });
      const logger = { error: () => undefined, warn: () => undefined };
      const reporter = createOperationalIncidentReporter({
        persistence: createPrismaOperationalIncidentPersistence({ prisma: db }),
        logger: logger as never,
        notifySupport: false,
      });
      const sink = createBillingIncidentSink(reporter, logger as never, "test");
      const scheduler = new BillingReconciliationSchedulerService(db, undefined, logger as never, () => new Date(), sink);
      const provider: PartnerSubscription = {
        planHandle: plan.shopifyPlanHandle,
        usageEventHandles: [],
        pendingPlanHandle: null, pendingEffectiveAt: null,
        status: "ACTIVE", currentPeriodStart: null, currentPeriodEnd: null,
        trialEndsAt: null, cancelAtPeriodEnd: false,
        providerSubscriptionId: `provider-${suffix}`,
        providerUsageSnapshot: [], providerUsagePricingSnapshot: [],
      };
      const projectedPlan = {
        ...plan,
        active: true,
        recoveryCreditPackEnabled: false,
        shopifyRecoveryCreditPackEventHandle: null,
      };
      await new GenericSubscriptionProjectionService(db, scheduler, logger as never).reconcile({
        shopId, provider, plan: projectedPlan,
        existing: {
          id: subscription.id, status: subscription.status, planId: null,
          pendingPlanId: null, pendingShopifyPlanHandle: null, pendingEffectiveAt: null,
          billingPeriodId: null, currentPeriodStart: null, currentPeriodEnd: null,
          nextReconcileAt: null,
        },
        projection: classifyObservedPlanProjection(provider, projectedPlan),
        now: new Date("2026-11-22T12:00:00Z"),
      });

      const committed = await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
      expect(committed.status).toBe(SubscriptionProjectionStatus.SYNC_ERROR);
      expect(committed.lastSyncErrorCode).toBe("MISSING_BILLING_CYCLE");
      expect(committed.observedShopifyPlanHandle).toBe(plan.shopifyPlanHandle);
      const incidents = await db.operationalIncident.findMany({ where: {
        shopId, category: "SHOPIFY_SUBSCRIPTION_BILLING",
      }, include: { events: true } });
      expect(incidents).toHaveLength(1);
      expect(incidents[0]!.reasonCode).toBe("MISSING_BILLING_CYCLE");
      expect(incidents[0]!.lastErrorMessage).toContain(plan.shopifyPlanHandle);
      expect(incidents[0]!.events).toHaveLength(1);
    } finally {
      // The disposable test DB is torn down by the integration runner;
      // incident history is append-only and must not be deleted manually.
      await db.$disconnect();
    }
  }, 45_000);
});
