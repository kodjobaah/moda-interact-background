import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  prisma: { $transaction: vi.fn() },
  listDiscounts: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../src/lib/db.js", () => ({ default: hoisted.prisma }));
vi.mock("../../../src/providers/shopify-discount.provider.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/providers/shopify-discount.provider.js")>(),
  shopifyDiscountProvider: { listDiscounts: hoisted.listDiscounts },
}));
vi.mock("@modainteract/moda-interact-shared/logging", () => ({
  createLogger: () => hoisted.logger,
}));
vi.mock("../../../src/runtime/deployment-environment.js", () => ({
  resolveDeploymentEnvironmentName: () => "test",
}));

import { ShopifyDiscountCatalogueService } from "../../../src/services/shopify-discount-catalogue.service.js";
import { ShopifyDiscountProviderError } from "../../../src/providers/shopify-discount.provider.js";

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

  it("logs safe provider diagnostics explicitly and stores a stable catalogue error code", async () => {
    const test = harness(true, true);
    const providerFailure = new ShopifyDiscountProviderError({
      httpStatus: 200,
      providerErrors: [{ code: "ACCESS_DENIED", message: "Permission denied for [REDACTED]" }],
      redactionApplied: true,
      truncated: false,
    });
    hoisted.listDiscounts.mockRejectedValueOnce(providerFailure);

    await expect(test.service.reconcile("shop-1", new Date("2026-10-02T12:00:00.000Z")))
      .rejects.toBe(providerFailure);

    expect(hoisted.logger.error).toHaveBeenCalledWith("shopify.discount_sync.provider_failed", expect.objectContaining({
      reasonCode: "SHOPIFY_DISCOUNT_PROVIDER_FAILED",
      origin: "provider_response",
      provider: "shopify",
      operation: "DiscountNodes",
      path: "/admin/api/2026-07/graphql.json",
      httpStatus: 200,
      providerErrors: [{ code: "ACCESS_DENIED", message: "Permission denied for [REDACTED]" }],
      errorStack: expect.stringContaining("ShopifyDiscountProviderError"),
      redactionApplied: true,
      truncated: false,
    }));
    const loggedFields = hoisted.logger.error.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(loggedFields).not.toHaveProperty("error");
    expect(loggedFields).not.toHaveProperty("providerErrorBody");
    expect(test.transaction.shopifyDiscountCatalogue.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "ERROR",
        lastErrorCode: "SHOPIFY_DISCOUNT_PROVIDER_FAILED",
      }),
    }));
  });

  it("passes actual exception stack and cause as explicit redacted logger fields", async () => {
    const test = harness(true, true);
    const cause = new Error("Socket closed for customer@example.com access_token=secret-cause-token");
    const providerFailure = new Error("Provider transport failed for customer@example.com Bearer secret-bearer-token", { cause });
    hoisted.listDiscounts.mockRejectedValueOnce(providerFailure);

    await expect(test.service.reconcile("shop-1", new Date("2026-10-02T12:00:00.000Z")))
      .rejects.toBe(providerFailure);

    expect(hoisted.logger.error).toHaveBeenCalledWith("shopify.discount_sync.provider_failed", expect.objectContaining({
      origin: "sdk_exception",
      errorName: "Error",
      errorMessage: "Provider transport failed for [REDACTED] Bearer [REDACTED]",
      errorStack: expect.stringContaining("Provider transport failed"),
      errorCause: [expect.objectContaining({
        name: "Error",
        message: "Socket closed for [REDACTED] access_token=[REDACTED]",
        stack: expect.stringContaining("Socket closed"),
      })],
      redactionApplied: true,
      truncated: false,
    }));
    const loggedFields = hoisted.logger.error.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(loggedFields).not.toHaveProperty("providerErrors");
    expect(loggedFields).not.toHaveProperty("error");
    expect(JSON.stringify(loggedFields)).not.toContain("customer@example.com");
    expect(JSON.stringify(loggedFields)).not.toContain("secret-cause-token");
    expect(JSON.stringify(loggedFields)).not.toContain("secret-bearer-token");
  });
});
