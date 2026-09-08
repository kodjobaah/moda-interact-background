import "dotenv/config";

import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { ShopifyUsageEventPublisherService } from "../../src/services/shopify-usage-event-publisher.service.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
    ? describe
    : describe.skip;

describeWithDatabase("Shopify usage publisher PostgreSQL concurrency", () => {
  it("invokes the provider at most once when two workers claim the same row", async () => {
    const shopId = randomUUID();
    const database = new PrismaClient();
    const firstClient = new PrismaClient();
    const secondClient = new PrismaClient();
    const firstProvider = { createBillingEvent: async () => undefined };
    const secondProvider = { createBillingEvent: async () => undefined };
    let providerCalls = 0;
    firstProvider.createBillingEvent = async () => {
      providerCalls += 1;
    };
    secondProvider.createBillingEvent = async () => {
      providerCalls += 1;
    };

    process.env.DATABASE_URL = testDatabaseUrl;
    try {
      await database.shop.create({
        data: {
          id: shopId,
          domain: `${shopId}.test`,
          shopifyShopId: `gid://shopify/Shop/${shopId}`,
          status: "ACTIVE",
        },
      });
      await database.usageEvent.create({
        data: {
          shopId,
          metric: "RECOVERY_CONVERSATION",
          quantity: 1,
          idempotencyKey: `usage:${shopId}`,
          shopifyReportState: "PENDING",
          shopifyEventHandle: "recovery-conversation",
          shopifyIdempotencyKey: `shopify:${shopId}`,
        },
      });

      const [first, second] = await Promise.all([
        new ShopifyUsageEventPublisherService(firstClient, firstProvider).publishDue(),
        new ShopifyUsageEventPublisherService(secondClient, secondProvider).publishDue(),
      ]);

      expect(first.claimed + second.claimed).toBe(1);
      expect(providerCalls).toBe(1);
      expect(await database.usageEvent.count({
        where: { shopId, shopifyReportState: "REPORTED" },
      })).toBe(1);
    } finally {
      await database.shop.delete({ where: { id: shopId } }).catch(() => undefined);
      await Promise.all([
        database.$disconnect(),
        firstClient.$disconnect(),
        secondClient.$disconnect(),
      ]);
    }
  }, 30_000);
});