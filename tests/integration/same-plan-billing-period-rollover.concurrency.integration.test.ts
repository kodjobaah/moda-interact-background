import "dotenv/config";

import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { SamePlanBillingPeriodRolloverService } from "../../src/services/same-plan-billing-period-rollover.service.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
    ? describe
    : describe.skip;

describeWithDatabase("same-plan billing-period rollover PostgreSQL concurrency", () => {
  it("serializes two independent transitions into one successor period", async () => {
    const shopId = randomUUID();
    const firstClient = new PrismaClient();
    const secondClient = new PrismaClient();
    const cleanupClient = new PrismaClient();
    process.env.DATABASE_URL = testDatabaseUrl;
    const providerStart = new Date("2026-10-01T00:00:00.000Z");
    const providerEnd = new Date("2026-11-01T00:00:00.000Z");

    try {
      const plan = await cleanupClient.billingPlan.create({
        data: {
          shopifyPlanHandle: `paid-${shopId}`,
          name: "Paid integration plan",
          kind: "PAID_METERED",
          shopifyUsageEventHandle: "recovery-meter",
          includedRecoveryConversationAllowance: 10,
          defaultOutboundSoftLimit: 10,
          defaultOutboundHardLimit: 20,
          terminalMessageReservedSlots: 1,
        },
      });
      await cleanupClient.shop.create({ data: { id: shopId, domain: `${shopId}.test`, status: "ACTIVE" } });
      const subscription = await cleanupClient.subscription.create({
        data: {
          shopId,
          planId: plan.id,
          status: "ACTIVE",
          observedShopifyPlanHandle: plan.shopifyPlanHandle,
          currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
          currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
        },
      });
      const period = await cleanupClient.billingPeriod.create({
        data: {
          shopId,
          subscriptionId: subscription.id,
          planId: plan.id,
          shopifyPlanHandleSnapshot: plan.shopifyPlanHandle,
          planNameSnapshot: plan.name,
          planKindSnapshot: "PAID_METERED",
          includedRecoveryCreditsGranted: 10,
          periodStart: new Date("2026-09-01T00:00:00.000Z"),
          periodEnd: new Date("2026-10-01T00:00:00.000Z"),
          status: "OPEN",
        },
      });
      await cleanupClient.subscription.update({ where: { id: subscription.id }, data: { billingPeriodId: period.id } });
      await cleanupClient.billingPeriodEntitlementCounter.create({
        data: {
          shopId,
          billingPeriodId: period.id,
          counter: "INCLUDED_RECOVERY_CREDITS",
          grantedQuantity: 10,
          committedQuantity: 0,
          reservedQuantity: 0,
          forfeitedQuantity: 0,
        },
      });

      const provider = {
        planHandle: plan.shopifyPlanHandle,
        usageEventHandles: ["recovery-meter"],
        pendingPlanHandle: null,
        pendingEffectiveAt: null,
        status: "ACTIVE" as const,
        currentPeriodStart: providerStart,
        currentPeriodEnd: providerEnd,
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        providerSubscriptionId: "provider-subscription",
        providerUsageSnapshot: [],
      };
      const rolloverPlan = {
        id: plan.id,
        active: true,
        name: plan.name,
        kind: "PAID_METERED" as const,
        shopifyPlanHandle: plan.shopifyPlanHandle,
        includedRecoveryConversationAllowance: 10,
        recoveryCreditPackEnabled: false,
        shopifyUsageEventHandle: "recovery-meter",
        shopifyRecoveryCreditPackEventHandle: null,
      };
      const input = {
        shopId,
        subscriptionId: subscription.id,
        provider,
        plan: rolloverPlan,
        now: new Date("2026-10-01T00:00:01.000Z"),
      };

      const [first, second] = await Promise.all([
        new SamePlanBillingPeriodRolloverService(firstClient).transition(input),
        new SamePlanBillingPeriodRolloverService(secondClient).transition(input),
      ]);

      expect([first.kind, second.kind].sort()).toEqual(["transitioned", "unchanged"]);
      const periods = await cleanupClient.billingPeriod.findMany({ where: { shopId }, orderBy: { periodStart: "asc" } });
      expect(periods).toHaveLength(2);
      expect(periods.filter((value) => value.periodStart.getTime() === providerStart.getTime())).toHaveLength(1);
      expect(periods.find((value) => value.periodStart.getTime() === providerStart.getTime())).toMatchObject({ status: "OPEN", planKindSnapshot: "PAID_METERED" });
      const current = await cleanupClient.subscription.findUnique({ where: { id: subscription.id } });
      expect(current?.billingPeriodId).toBe(periods[1].id);
      const counters = await cleanupClient.billingPeriodEntitlementCounter.findMany({ where: { shopId } });
      expect(counters).toHaveLength(2);
      expect(counters.filter((value) => value.billingPeriodId === periods[1].id)).toHaveLength(1);
    } finally {
      await cleanupClient.shop.delete({ where: { id: shopId } }).catch(() => undefined);
      await Promise.all([firstClient.$disconnect(), secondClient.$disconnect(), cleanupClient.$disconnect()]);
    }
  }, 30_000);
});