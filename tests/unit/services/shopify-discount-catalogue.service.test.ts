import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  prisma: { $transaction: vi.fn() },
  listDiscounts: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../src/lib/db.js", () => ({ default: hoisted.prisma }));
vi.mock("../../../src/providers/shopify-discount.provider.js", () => ({
  shopifyDiscountProvider: { listDiscounts: hoisted.listDiscounts },
}));
vi.mock("@modainteract/moda-interact-shared/logging", () => ({
  createLogger: () => hoisted.logger,
}));
vi.mock("../../../src/runtime/deployment-environment.js", () => ({
  resolveDeploymentEnvironmentName: () => "test",
}));

import { ShopifyDiscountCatalogueService } from "../../../src/services/shopify-discount-catalogue.service.js";

function harness(onboardingCompleted: boolean, legacyOnboardingCompleted: boolean) {
  const shopFindUnique = vi.fn()
    .mockResolvedValueOnce({ id: "shop-1" })
    .mockResolvedValueOnce({
      domain: "merchant.example",
      status: "ACTIVE",
      onboardingCompleted,
      settings: { onboardingCompleted: legacyOnboardingCompleted },
      subscription: { status: "ACTIVE" },
    });
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    shop: { findUnique: shopFindUnique },
    shopifyDiscountCatalogue: {
      upsert: vi.fn().mockResolvedValue({ syncRequestedAt: null, unavailableAt: null }),
      findUnique: vi.fn().mockResolvedValue({ syncRequestedAt: null, unavailableAt: null }),
      update: vi.fn().mockResolvedValue({}),
    },
    shopifyDiscount: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    session: { findFirst: vi.fn().mockResolvedValue({ scope: "read_discounts" }) },
  };
  hoisted.prisma.$transaction.mockImplementation(async (callback: (value: typeof transaction) => unknown) => callback(transaction));
  return { transaction, service: new ShopifyDiscountCatalogueService() };
}

describe("ShopifyDiscountCatalogueService onboarding eligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects eligibility when the shared Shop milestone is false even if the legacy mirror is true", async () => {
    const test = harness(false, true);

    await expect(test.service.requestSync("shop-1", new Date("2026-10-02T12:00:00.000Z"))).resolves.toBe("unavailable");

    const eligibilityQuery = test.transaction.shop.findUnique.mock.calls[1][0];
    expect(eligibilityQuery.select).toEqual(expect.objectContaining({ onboardingCompleted: true }));
    expect(eligibilityQuery.select).not.toHaveProperty("settings");
    expect(test.transaction.shopifyDiscountCatalogue.update).not.toHaveBeenCalled();
  });

  it("allows eligibility when the shared Shop milestone is true even if the legacy mirror is false", async () => {
    const test = harness(true, false);

    await expect(test.service.requestSync("shop-1", new Date("2026-10-02T12:00:00.000Z"))).resolves.toBe("requested");

    const eligibilityQuery = test.transaction.shop.findUnique.mock.calls[1][0];
    expect(eligibilityQuery.select).toEqual(expect.objectContaining({ onboardingCompleted: true }));
    expect(eligibilityQuery.select).not.toHaveProperty("settings");
    expect(test.transaction.shopifyDiscountCatalogue.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SYNC_REQUIRED" }),
    }));
  });
});
