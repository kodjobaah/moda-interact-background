import { describe, expect, it, vi } from "vitest";
import { PrismaRecoveryOfferRepository } from "../../../../src/services/recovery-offers/recovery-offer-repository.js";

describe("Recovery offer PostgreSQL read adapter", () => {
  it("restricts checkout, catalogue, and candidates to shop and never writes", async () => {
    const database = {
      shop: { findUnique: vi.fn(async () => ({ id: "s", status: "ACTIVE", platform: "SHOPIFY" })) },
      checkoutRecovery: { findFirst: vi.fn(async () => ({ id: "r", shopId: "s", checkoutToken: "c",
        currency: "USD", status: "DETECTED", totalPrice: { toString: () => "100.00" },
        lineItems: [], lastExternalActivityAt: new Date(), updatedAt: new Date() })) },
      shopifyDiscountCatalogue: { findUnique: vi.fn(async () => null) },
      shopifyDiscount: { findMany: vi.fn(async () => []) },
    };
    const repo = new PrismaRecoveryOfferRepository(database as unknown as ConstructorParameters<typeof PrismaRecoveryOfferRepository>[0]);
    await repo.readShop("s");
    await repo.readCheckout("s", "r");
    await repo.readCatalogue("s");
    await repo.readDiscounts("s", ["id-a", "id-b"], 9);
    expect(database.checkoutRecovery.findFirst).toHaveBeenCalledWith({
      where: { id: "r", shopId: "s" }, select: expect.anything(),
    });
    expect(database.shopifyDiscount.findMany).toHaveBeenCalledWith({
      where: { shopId: "s", isAvailable: true, unavailableAt: null,
        id: { in: ["id-a", "id-b"] } },
      select: expect.anything(), orderBy: { id: "asc" }, take: 9,
    });
    expect(Object.keys(database.checkoutRecovery)).toEqual(["findFirst"]);
  });
});
