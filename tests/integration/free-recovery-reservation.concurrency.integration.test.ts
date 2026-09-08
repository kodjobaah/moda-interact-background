import "dotenv/config";

import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { FreeRecoveryReservationService } from "../../src/services/free-recovery-reservation.service.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
    ? describe
    : describe.skip;

describeWithDatabase("Free recovery reservation PostgreSQL concurrency", () => {
  it("allows at most one concurrent reservation for the final credit", async () => {
    const shopId = randomUUID();
    const database = new PrismaClient();
    const firstClient = new PrismaClient();
    const secondClient = new PrismaClient();

    process.env.DATABASE_URL = testDatabaseUrl;
    try {
      const plan = await database.billingPlan.create({
        data: {
          shopifyPlanHandle: `free-${shopId}`,
          name: "Free integration plan",
          kind: "FREE",
          freeLifetimeConversationAllowance: 1,
          defaultOutboundSoftLimit: 10,
          defaultOutboundHardLimit: 20,
          terminalMessageReservedSlots: 1,
        },
      });
      await database.shop.create({ data: { id: shopId, domain: `${shopId}.test`, status: "ACTIVE" } });
      await database.subscription.create({
        data: {
          shopId,
          planId: plan.id,
          status: "ACTIVE",
          observedShopifyPlanHandle: plan.shopifyPlanHandle,
        },
      });
      await database.platformBillingPolicy.create({
        data: {
          absoluteOutboundHardLimit: 20,
          defaultWarningPercent: 80,
        },
      });

      const [first, second] = await Promise.all([
        new FreeRecoveryReservationService(firstClient).reserve({ shopId, sourceKey: `${shopId}:recovery:1` }),
        new FreeRecoveryReservationService(secondClient).reserve({ shopId, sourceKey: `${shopId}:recovery:2` }),
      ]);
      const outcomes = [first, second];

      expect(outcomes.filter((outcome) => outcome.kind === "reserved")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.kind === "allowance-exhausted")).toHaveLength(1);

      const counter = await database.shopEntitlementCounter.findUnique({
        where: { shopId_counter: { shopId, counter: "FREE_RECOVERY_LIFETIME" } },
      });
      expect(counter).toMatchObject({ committedQuantity: 0, reservedQuantity: 1 });
      expect(await database.usageReservation.count({ where: { shopId } })).toBe(1);
    } finally {
      await database.shop.delete({ where: { id: shopId } }).catch(() => undefined);
      await Promise.all([database.$disconnect(), firstClient.$disconnect(), secondClient.$disconnect()]);
    }
  }, 30_000);
});