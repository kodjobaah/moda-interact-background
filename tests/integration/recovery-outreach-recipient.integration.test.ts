import "dotenv/config";

import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const disposableIntegrationEnabled = process.env.MODA_DISPOSABLE_INTEGRATION === "1";
const describeWithDatabase = testDatabaseUrl && disposableIntegrationEnabled ? describe : describe.skip;

describeWithDatabase("recovery outreach recipient PostgreSQL contract", () => {
  it("persists the required canonical recipient on an outreach attempt", async () => {
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
      const attempt = await database.recoveryOutreachAttempt.create({
        data: {
          checkoutRecoveryId: recovery.id,
          sequence: 1,
          trigger: "INITIAL",
          recipient: "447700900123",
          configuredOfferMode: "NONE",
        },
      });

      expect(attempt.recipient).toBe("447700900123");
    } finally {
      await database.shop.deleteMany({ where: { id: shopId } });
      await database.$disconnect();
    }
  }, 30_000);
});