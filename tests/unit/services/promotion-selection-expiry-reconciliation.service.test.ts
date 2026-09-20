import { describe, expect, it, vi } from "vitest";

import { PromotionSelectionExpiryReconciliationService } from "../../../src/services/promotion-selection-expiry-reconciliation.service.js";

const cutoff = new Date("2026-09-20T00:00:00.000Z");

function createDatabase(candidates: unknown[] = [], deleteCounts: number[] = []) {
  const findMany = vi.fn().mockResolvedValue(candidates);
  const deleteMany = vi.fn();
  for (const count of deleteCounts) deleteMany.mockResolvedValueOnce({ count });
  return {
    merchantPromotionSelection: { findMany, deleteMany },
    promotionCampaign: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    promotionalCreditGrant: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    usageReservation: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  };
}

const candidate = {
  id: "selection-1",
  shopId: "shop-1",
  promotionalCreditGrantId: "grant-1",
};

describe("PromotionSelectionExpiryReconciliationService", () => {
  it("selects expired pointers with the configured batch size", async () => {
    const database = createDatabase();
    await new PromotionSelectionExpiryReconciliationService(database as never, () => cutoff).reconcileOnce({
      billingReconciliationShopBatchSize: 17,
    });

    expect(database.merchantPromotionSelection.findMany).toHaveBeenCalledWith({
      where: { promotionalCreditGrant: { campaign: { expiresAt: { lte: cutoff } } } },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: 17,
      select: { id: true, shopId: true, promotionalCreditGrantId: true },
    });
  });

  it("returns zero counts when there are no candidates", async () => {
    const database = createDatabase();
    await expect(
      new PromotionSelectionExpiryReconciliationService(database as never, () => cutoff).reconcileOnce({
        billingReconciliationShopBatchSize: 10,
      }),
    ).resolves.toEqual({ selected: 0, released: 0, raced: 0 });
  });

  it("counts successful deletes and races", async () => {
    const database = createDatabase([candidate, { ...candidate, id: "selection-2" }], [1, 0]);
    await expect(
      new PromotionSelectionExpiryReconciliationService(database as never, () => cutoff).reconcileOnce({
        billingReconciliationShopBatchSize: 10,
      }),
    ).resolves.toEqual({ selected: 2, released: 1, raced: 1 });
  });

  it("uses the candidate identity and the same expiry cutoff in the final delete", async () => {
    const database = createDatabase([candidate], [0]);
    await new PromotionSelectionExpiryReconciliationService(database as never, () => cutoff).reconcileOnce({
      billingReconciliationShopBatchSize: 10,
    });

    expect(database.merchantPromotionSelection.deleteMany).toHaveBeenCalledWith({
      where: {
        id: candidate.id,
        shopId: candidate.shopId,
        promotionalCreditGrantId: candidate.promotionalCreditGrantId,
        promotionalCreditGrant: { campaign: { expiresAt: { lte: cutoff } } },
      },
    });
  });

  it("does not mutate campaign, grant, or reservation models", async () => {
    const database = createDatabase([candidate], [1]);
    await new PromotionSelectionExpiryReconciliationService(database as never, () => cutoff).reconcileOnce({
      billingReconciliationShopBatchSize: 10,
    });

    for (const model of [database.promotionCampaign, database.promotionalCreditGrant, database.usageReservation]) {
      expect(model.create).not.toHaveBeenCalled();
      expect(model.update).not.toHaveBeenCalled();
      expect(model.delete).not.toHaveBeenCalled();
    }
  });
});