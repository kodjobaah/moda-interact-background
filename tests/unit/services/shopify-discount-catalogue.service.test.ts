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
  const catalogueState: Record<string, unknown> = {
    syncRequestedAt: null, unavailableAt: null, syncGeneration: 0, activeSyncToken: null,
  };
  const shopFindUnique = vi.fn()
    .mockResolvedValueOnce({ id: "shop-1" })
    .mockResolvedValueOnce({
      domain: "merchant.example",
      status: "ACTIVE",
      onboardingCompleted,
      settings: { onboardingCompleted: legacyOnboardingCompleted },
      subscription: { status: "ACTIVE" },
    })
    .mockImplementation(async ({ select }: { select?: Record<string, unknown> }) => select?.domain
      ? { domain: "merchant.example", status: "ACTIVE", onboardingCompleted,
        subscription: { status: "ACTIVE" } }
      : { id: "shop-1", domain: "merchant.example" });
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    shop: { findUnique: shopFindUnique },
    shopifyDiscountCatalogue: {
      upsert: vi.fn().mockImplementation(async () => ({ ...catalogueState })),
      findUnique: vi.fn().mockImplementation(async () => ({ ...catalogueState })),
      update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(catalogueState, data);
        return { ...catalogueState };
      }),
    },
    shopifyDiscount: {
      upsert: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    session: { findFirst: vi.fn().mockResolvedValue({ scope: "read_discounts" }) },
  };
  hoisted.prisma.$transaction.mockImplementation(async (callback: (value: typeof transaction) => unknown) => callback(transaction));
  return { transaction, service: new ShopifyDiscountCatalogueService() };
}

function observedDiscount() {
  return {
    shopifyDiscountNodeId: "gid://shopify/DiscountAutomaticNode/1",
    providerType: "DiscountAutomaticBasic", method: "AUTOMATIC" as const,
    providerStatus: "ACTIVE", title: "Ten percent", summary: "10% off", startsAt: null, endsAt: null,
    codeCount: null, singleRedeemCode: null, fixedSelectable: true,
    providerSnapshot: { conditionFacts: { completeness: "COMPLETE", discountKind: "PERCENTAGE" } },
  };
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

  it("keeps a failed provider read retryable and persists enriched facts on the next successful sync", async () => {
    const test = harness(true, true);
    hoisted.listDiscounts.mockRejectedValueOnce(new Error("temporary provider failure"))
      .mockResolvedValueOnce([observedDiscount()]);

    await expect(test.service.reconcile("shop-1", new Date("2026-10-02T12:00:00.000Z")))
      .rejects.toThrow("temporary provider failure");
    expect(test.transaction.shopifyDiscount.upsert).not.toHaveBeenCalled();

    await expect(test.service.reconcile("shop-1", new Date("2026-10-02T12:01:00.000Z")))
      .resolves.toBe("current");

    expect(hoisted.listDiscounts).toHaveBeenCalledTimes(2);
    expect(test.transaction.shopifyDiscount.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        providerStatus: "ACTIVE",
        providerSnapshot: { conditionFacts: { completeness: "COMPLETE", discountKind: "PERCENTAGE" } },
      }),
    }));
    expect(test.transaction.shopifyDiscount.upsert.mock.calls[0]?.[0]?.update).not.toHaveProperty("isAvailable");
    expect(test.transaction.shopifyDiscountCatalogue.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "CURRENT", activeSyncToken: null }),
    }));
  });
});
