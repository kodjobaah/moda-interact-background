import "dotenv/config";

import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { PaidIncludedRecoveryReservationService } from "../../src/services/paid-included-recovery-reservation.service.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
    ? describe
    : describe.skip;

describeWithDatabase("Paid included recovery reservation PostgreSQL concurrency", () => {
  it("admits and commits at most one of two distinct recoveries for the final included credit", async () => {
    const shopId = randomUUID();
    const fixedNow = new Date("2026-09-12T12:00:00.000Z");
    process.env.DATABASE_URL = testDatabaseUrl;
    const database = new PrismaClient();
    const firstClient = new PrismaClient();
    const secondClient = new PrismaClient();

    try {
      const plan = await database.billingPlan.create({
        data: {
          shopifyPlanHandle: `paid-${shopId}`,
          name: "Paid integration plan",
          kind: "PAID_METERED",
          shopifyUsageEventHandle: "paid-recovery-meter",
          includedRecoveryConversationAllowance: 1,
          defaultOutboundSoftLimit: 10,
          defaultOutboundHardLimit: 20,
          terminalMessageReservedSlots: 1,
        },
      });
      await database.shop.create({ data: { id: shopId, domain: `${shopId}.test`, status: "ACTIVE" } });
      const subscription = await database.subscription.create({
        data: {
          shopId,
          planId: plan.id,
          status: "ACTIVE",
          observedShopifyPlanHandle: plan.shopifyPlanHandle,
          currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
          currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
        },
      });
      const period = await database.billingPeriod.create({
        data: {
          shopId,
          subscriptionId: subscription.id,
          planId: plan.id,
          planKindSnapshot: "PAID_METERED",
          periodStart: new Date("2026-09-01T00:00:00.000Z"),
          periodEnd: new Date("2026-10-01T00:00:00.000Z"),
          status: "OPEN",
        },
      });
      await database.subscription.update({
        where: { id: subscription.id },
        data: { billingPeriodId: period.id },
      });
      await database.platformBillingPolicy.upsert({
        where: { id: "default" },
        update: { absoluteOutboundHardLimit: 20, defaultWarningPercent: 80 },
        create: { absoluteOutboundHardLimit: 20, defaultWarningPercent: 80 },
      });
      await database.shopEntitlementCounter.create({
        data: { shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS", grantedQuantity: 0 },
      });
      await database.billingPeriodEntitlementCounter.create({
        data: {
          shopId,
          billingPeriodId: period.id,
          counter: "INCLUDED_RECOVERY_CREDITS",
          grantedQuantity: 1,
        },
      });

      const [first, second] = await Promise.all([
        new PaidIncludedRecoveryReservationService(firstClient, 3, () => fixedNow).reserve({ shopId, recoveryId: "recovery-a" }),
        new PaidIncludedRecoveryReservationService(secondClient, 3, () => fixedNow).reserve({ shopId, recoveryId: "recovery-b" }),
      ]);
      const outcomes = [first, second];
      expect(outcomes.filter((outcome) => outcome.kind === "reserved")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.kind === "allowance-exhausted")).toHaveLength(1);

      const admitted = outcomes.find((outcome) => outcome.kind === "reserved");
      if (!admitted || admitted.kind !== "reserved") throw new Error("expected one admitted reservation");
      const commitClient = new PaidIncludedRecoveryReservationService(database, 3, () => fixedNow);
      await expect(commitClient.commit({ shopId, sourceKey: admitted.sourceKey })).resolves.toMatchObject({ kind: "committed" });

      const counter = await database.billingPeriodEntitlementCounter.findUnique({
        where: {
          billingPeriodId_counter: {
            billingPeriodId: period.id,
            counter: "INCLUDED_RECOVERY_CREDITS",
          },
        },
      });
      expect(counter).toMatchObject({ grantedQuantity: 1, committedQuantity: 1, reservedQuantity: 0 });
      expect(counter!.committedQuantity).toBeLessThanOrEqual(counter!.grantedQuantity);

      const usageEvents = await database.usageEvent.findMany({
        where: { shopId, metric: "RECOVERY_CONVERSATION" },
      });
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0]).toMatchObject({
        billingPeriodId: period.id,
        shopifyReportState: "PENDING",
        shopifyEventHandle: "paid-recovery-meter",
      });
    } finally {
      await database.shop.delete({ where: { id: shopId } }).catch(() => undefined);
      await Promise.all([database.$disconnect(), firstClient.$disconnect(), secondClient.$disconnect()]);
    }
  }, 30_000);
});
