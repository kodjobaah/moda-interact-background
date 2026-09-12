import "dotenv/config";

import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { PromotionalRecoveryReservationService } from "../../src/services/promotional-recovery-reservation.service.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

describeWithDatabase("Promotional recovery reservation PostgreSQL concurrency", () => {
  it("allows exactly one worker to reserve the final selected promotional credit", async () => {
    const shopId = randomUUID();
    const database = new PrismaClient();
    const firstClient = new PrismaClient();
    const secondClient = new PrismaClient();
    process.env.DATABASE_URL = testDatabaseUrl;

    let planId = "";
    let campaignId = "";
    let adminId = "";
    try {
      const plan = await database.billingPlan.create({
        data: {
          shopifyPlanHandle: `promo-${shopId}`,
          name: "Promotional integration plan",
          kind: "FREE",
          defaultOutboundSoftLimit: 10,
          defaultOutboundHardLimit: 20,
          terminalMessageReservedSlots: 1,
        },
      });
      planId = plan.id;
      await database.shop.create({ data: { id: shopId, domain: `${shopId}.test`, status: "ACTIVE" } });
      await database.subscription.create({
        data: { shopId, planId, status: "ACTIVE", observedShopifyPlanHandle: plan.shopifyPlanHandle },
      });
      await database.shopEntitlementCounter.create({
        data: { shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS", grantedQuantity: 0 },
      });
      await database.platformBillingPolicy.upsert({
        where: { id: "default" },
        update: {},
        create: { absoluteOutboundHardLimit: 20, defaultWarningPercent: 80 },
      });
      const admin = await database.platformAdmin.create({ data: { email: `${shopId}@test.invalid` } });
      adminId = admin.id;
      const campaign = await database.promotionCampaign.create({
        data: {
          name: "Concurrency campaign",
          scope: "GLOBAL",
          quantity: 1,
          startsAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2027-01-01T00:00:00.000Z"),
          status: "ACTIVE",
          createdByPlatformAdminId: adminId,
        },
      });
      campaignId = campaign.id;
      const grant = await database.promotionalCreditGrant.create({
        data: { shopId, campaignId, quantity: 1 },
      });
      await database.merchantPromotionSelection.create({
        data: { shopId, promotionalCreditGrantId: grant.id },
      });

      const [first, second] = await Promise.all([
        new PromotionalRecoveryReservationService(firstClient).reserve({ shopId, planId, sourceKey: `${shopId}:recovery:1` }),
        new PromotionalRecoveryReservationService(secondClient).reserve({ shopId, planId, sourceKey: `${shopId}:recovery:2` }),
      ]);
      const outcomes = [first, second];
      expect(outcomes.filter((outcome) => outcome.kind === "reserved")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.kind === "unavailable")).toHaveLength(1);

      const persistedGrant = await database.promotionalCreditGrant.findUnique({ where: { id: grant.id } });
      expect(persistedGrant).toMatchObject({ reservedQuantity: 1, committedQuantity: 0, selectionCount: 0 });
      expect(await database.usageReservation.count({ where: { shopId } })).toBe(1);
    } finally {
      await database.merchantPromotionSelection.deleteMany({ where: { shopId } }).catch(() => undefined);
      await database.promotionalCreditGrant.deleteMany({ where: { shopId } }).catch(() => undefined);
      if (campaignId) await database.promotionCampaign.delete({ where: { id: campaignId } }).catch(() => undefined);
      await database.subscription.delete({ where: { shopId } }).catch(() => undefined);
      await database.shop.delete({ where: { id: shopId } }).catch(() => undefined);
      if (planId) await database.billingPlan.delete({ where: { id: planId } }).catch(() => undefined);
      if (adminId) await database.platformAdmin.delete({ where: { id: adminId } }).catch(() => undefined);
      await Promise.all([database.$disconnect(), firstClient.$disconnect(), secondClient.$disconnect()]);
    }
  }, 30_000);
});
