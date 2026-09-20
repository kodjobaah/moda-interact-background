import "dotenv/config";

import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { PromotionSelectionExpiryReconciliationService } from "../../src/services/promotion-selection-expiry-reconciliation.service.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIntegration =
  testDatabaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
    ? describe
    : describe.skip;

const cutoff = new Date("2026-09-20T00:00:00.000Z");

async function createSelection(database: PrismaClient, expiresAt: Date) {
  const shopId = randomUUID();
  const admin = await database.platformAdmin.create({
    data: { email: `${shopId}@test.invalid` },
  });
  const campaign = await database.promotionCampaign.create({
    data: {
      name: `Expiry reconciliation ${shopId}`,
      scope: "GLOBAL",
      quantity: 3,
      startsAt: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt,
      status: "ACTIVE",
      createdByPlatformAdminId: admin.id,
    },
  });
  const shop = await database.shop.create({
    data: { id: shopId, domain: `${shopId}.test`, status: "ACTIVE" },
  });
  const grant = await database.promotionalCreditGrant.create({
    data: { shopId: shop.id, campaignId: campaign.id, quantity: 3 },
  });
  const selection = await database.merchantPromotionSelection.create({
    data: { shopId: shop.id, promotionalCreditGrantId: grant.id },
  });
  return { admin, campaign, grant, selection, shop };
}

async function removeSelection(database: PrismaClient, ids: Awaited<ReturnType<typeof createSelection>>) {
  await database.merchantPromotionSelection.deleteMany({ where: { shopId: ids.shop.id } });
  await database.promotionalCreditGrant.deleteMany({ where: { shopId: ids.shop.id } });
  await database.promotionCampaign.delete({ where: { id: ids.campaign.id } }).catch(() => undefined);
  await database.shop.delete({ where: { id: ids.shop.id } }).catch(() => undefined);
  await database.platformAdmin.delete({ where: { id: ids.admin.id } }).catch(() => undefined);
}

describeIntegration("promotion selection expiry reconciliation PostgreSQL", () => {
  it("deletes expired pointers without changing grant quantities or history", async () => {
    const database = new PrismaClient();
    const ids = await createSelection(database, new Date("2026-09-19T23:59:59.000Z"));
    try {
      const before = await database.promotionalCreditGrant.findUnique({ where: { id: ids.grant.id } });
      await expect(
        new PromotionSelectionExpiryReconciliationService(database, () => cutoff).reconcileOnce({
          billingReconciliationShopBatchSize: 10,
        }),
      ).resolves.toEqual({ selected: 1, released: 1, raced: 0 });
      expect(await database.merchantPromotionSelection.findUnique({ where: { id: ids.selection.id } })).toBeNull();
      expect(await database.promotionalCreditGrant.findUnique({ where: { id: ids.grant.id } })).toEqual(before);
    } finally {
      await removeSelection(database, ids);
      await database.$disconnect();
    }
  }, 30_000);

  it("keeps an unexpired pointer", async () => {
    const database = new PrismaClient();
    const ids = await createSelection(database, new Date("2026-09-20T00:00:01.000Z"));
    try {
      await expect(
        new PromotionSelectionExpiryReconciliationService(database, () => cutoff).reconcileOnce({
          billingReconciliationShopBatchSize: 10,
        }),
      ).resolves.toEqual({ selected: 0, released: 0, raced: 0 });
      expect(await database.merchantPromotionSelection.findUnique({ where: { id: ids.selection.id } })).not.toBeNull();
    } finally {
      await removeSelection(database, ids);
      await database.$disconnect();
    }
  }, 30_000);

  it("does not delete a newer replacement selection", async () => {
    const database = new PrismaClient();
    const ids = await createSelection(database, new Date("2026-09-19T23:59:59.000Z"));
    const replacement = await createSelection(database, new Date("2026-12-01T00:00:00.000Z"));
    try {
      await database.merchantPromotionSelection.delete({ where: { id: replacement.selection.id } });
      await database.promotionalCreditGrant.update({ where: { id: replacement.grant.id }, data: { shopId: ids.shop.id } });
      await database.merchantPromotionSelection.update({ where: { id: ids.selection.id }, data: { promotionalCreditGrantId: replacement.grant.id } });
      const originalFindMany = database.merchantPromotionSelection.findMany.bind(database.merchantPromotionSelection);
      const racingDatabase = Object.assign(database, {
        merchantPromotionSelection: {
          ...database.merchantPromotionSelection,
          findMany: async (args: Parameters<typeof originalFindMany>[0]) => {
            const candidates = await originalFindMany(args);
            await database.merchantPromotionSelection.update({ where: { id: ids.selection.id }, data: { promotionalCreditGrantId: replacement.grant.id } });
            return candidates;
          },
        },
      });
      const result = await new PromotionSelectionExpiryReconciliationService(racingDatabase, () => cutoff).reconcileOnce({ billingReconciliationShopBatchSize: 10 });
      expect(result).toEqual({ selected: 1, released: 0, raced: 1 });
      expect(await database.merchantPromotionSelection.findUnique({ where: { shopId: ids.shop.id } })).toMatchObject({ promotionalCreditGrantId: replacement.grant.id });
    } finally {
      await database.merchantPromotionSelection.deleteMany({ where: { shopId: ids.shop.id } });
      await database.promotionalCreditGrant.deleteMany({ where: { shopId: ids.shop.id } });
      await database.promotionCampaign.deleteMany({ where: { id: { in: [ids.campaign.id, replacement.campaign.id] } } });
      await database.shop.delete({ where: { id: ids.shop.id } }).catch(() => undefined);
      await database.shop.delete({ where: { id: replacement.shop.id } }).catch(() => undefined);
      await database.platformAdmin.deleteMany({ where: { id: { in: [ids.admin.id, replacement.admin.id] } } });
      await database.$disconnect();
    }
  }, 30_000);

  it("does not delete when campaign expiry is extended past the cutoff", async () => {
    const database = new PrismaClient();
    const ids = await createSelection(database, new Date("2026-09-19T23:59:59.000Z"));
    try {
      const originalFindMany = database.merchantPromotionSelection.findMany.bind(database.merchantPromotionSelection);
      const racingDatabase = Object.assign(database, {
        merchantPromotionSelection: {
          ...database.merchantPromotionSelection,
          findMany: async (args: Parameters<typeof originalFindMany>[0]) => {
            const candidates = await originalFindMany(args);
            await database.promotionCampaign.update({ where: { id: ids.campaign.id }, data: { expiresAt: new Date("2026-12-01T00:00:00.000Z") } });
            return candidates;
          },
        },
      });
      await expect(
        new PromotionSelectionExpiryReconciliationService(racingDatabase, () => cutoff).reconcileOnce({
          billingReconciliationShopBatchSize: 10,
        }),
      ).resolves.toEqual({ selected: 1, released: 0, raced: 1 });
      expect(await database.merchantPromotionSelection.findUnique({ where: { id: ids.selection.id } })).not.toBeNull();
    } finally {
      await removeSelection(database, ids);
      await database.$disconnect();
    }
  }, 30_000);
});