import "dotenv/config";

import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { RecoveryOutreachAttemptService } from "../../src/services/recovery-outreach-attempt.service.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const disposableIntegrationEnabled = process.env.MODA_DISPOSABLE_INTEGRATION === "1";
const describeWithDatabase = testDatabaseUrl && disposableIntegrationEnabled ? describe : describe.skip;

describeWithDatabase("recovery outreach recipient PostgreSQL contract", () => {
  it("persists immutable initial and follow-up recipients through the attempt writer", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const database = new PrismaClient();
    const suffix = randomUUID();
    const shopId = `recipient-shop-${suffix}`;

    try {
      const shop = await database.shop.create({
        data: { id: shopId, domain: `${shopId}.test` },
      });
      const customer = await database.customer.create({
        data: { shopId: shop.id },
      });
      const recovery = await database.checkoutRecovery.create({
        data: {
          shopId: shop.id,
          customerId: customer.id,
          checkoutToken: `recipient-checkout-${suffix}`,
          lastExternalActivityAt: new Date(),
        },
      });
      const attempts = new RecoveryOutreachAttemptService(database);
      const policy = {
        recoveryDelayMinutes: 30,
        recoveryOfferMode: "NONE" as const,
        fixedShopifyDiscountId: null,
        followUpEnabled: true,
        followUpDelayMinutes: 60,
        source: "MERCHANT" as const,
        offerSnapshot: null,
      };
      const initialAttempt = await attempts.getOrCreate({
        recoveryId: recovery.id,
        sequence: 1,
        policy,
        recipient: "447700900123",
      });
      const followUpAttempt = await attempts.getOrCreateFollowUp({
        recoveryId: recovery.id,
        recipient: "15551234567",
        initialAttempt: {
          configuredOfferMode: policy.recoveryOfferMode,
          fixedShopifyDiscountId: policy.fixedShopifyDiscountId,
          offerSnapshot: policy.offerSnapshot,
        },
      });

      await attempts.getOrCreate({
        recoveryId: recovery.id,
        sequence: 1,
        policy,
        recipient: "33123456789",
      });
      await attempts.getOrCreateFollowUp({
        recoveryId: recovery.id,
        recipient: "33123456789",
        initialAttempt: {
          configuredOfferMode: policy.recoveryOfferMode,
          fixedShopifyDiscountId: policy.fixedShopifyDiscountId,
          offerSnapshot: policy.offerSnapshot,
        },
      });

      const persistedAttempts = await database.recoveryOutreachAttempt.findMany({
        where: { checkoutRecoveryId: recovery.id },
        orderBy: { sequence: "asc" },
      });
      const persistedRecovery = await database.checkoutRecovery.findUnique({
        where: { id: recovery.id },
        select: { shopId: true },
      });

      expect(initialAttempt.recipient).toBe("447700900123");
      expect(followUpAttempt.recipient).toBe("15551234567");
      expect(persistedRecovery?.shopId).toBe(shop.id);
      expect(persistedAttempts).toMatchObject([
        {
          checkoutRecoveryId: recovery.id,
          sequence: 1,
          recipient: "447700900123",
        },
        {
          checkoutRecoveryId: recovery.id,
          sequence: 2,
          recipient: "15551234567",
        },
      ]);
    } finally {
      await database.shop.deleteMany({ where: { id: shopId } });
      await database.$disconnect();
    }
  }, 30_000);
});