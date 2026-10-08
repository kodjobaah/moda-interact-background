import { describe, expect, it, vi } from "vitest";
import { ShopExecutionEligibilityService } from "../../../src/services/shop-execution-eligibility.service.js";

function service(
  status: string | null,
  shopStatus = "ACTIVE",
  options: {
    onboardingCompleted?: boolean;
    lastProviderLifecycleState?: string | null;
    platform?: "SHOPIFY" | "WOOCOMMERCE";
  } = {},
) {
  return new ShopExecutionEligibilityService({
    subscription: {
      findUnique: vi.fn().mockResolvedValue({
        status,
        lastProviderLifecycleState:
          options.lastProviderLifecycleState ?? null,
        shop: {
          status: shopStatus,
          platform: options.platform ?? "SHOPIFY",
          onboardingCompleted: options.onboardingCompleted ?? false,
        },
      }),
    },
  } as never);
}

describe("ShopExecutionEligibilityService", () => {
  it.each([
    ["ACTIVE", { allowed: true, shopId: "shop-1" }],
    ["TRIALING", { allowed: true, shopId: "shop-1" }],
    ["NO_CONTRACT", { allowed: false, shopId: "shop-1", reason: "CONTRACT_REQUIRED" }],
    ["FROZEN", { allowed: false, shopId: "shop-1", reason: "SUBSCRIPTION_FROZEN" }],
    ["UNMAPPED", { allowed: false, shopId: "shop-1", reason: "UNMAPPED_PLAN" }],
    ["SYNC_ERROR", { allowed: false, shopId: "shop-1", reason: "SYNC_ERROR" }],
  ])("maps a resolved shop projection for %s", (status, expected) => {
    const eligibility = new ShopExecutionEligibilityService();

    expect(
      eligibility.evaluateResolvedShop({
        id: "shop-1",
        status: "ACTIVE",
        platform: "SHOPIFY",
        subscription: { status },
      }),
    ).toEqual(expected);
  });

  it("denies an inactive resolved shop before interpreting subscription state", () => {
    const eligibility = new ShopExecutionEligibilityService();

    expect(
      eligibility.evaluateResolvedShop({
        id: "shop-1",
        status: "UNINSTALLED",
        subscription: { status: "ACTIVE" },
      }),
    ).toEqual({ allowed: false, shopId: "shop-1", reason: "SHOP_UNAVAILABLE" });
  });

  it.each([
    ["ACTIVE", { allowed: true, shopId: "shop-1" }],
    ["TRIALING", { allowed: true, shopId: "shop-1" }],
  ])("allows executable subscription state %s", async (status, expected) => {
    await expect(service(status).evaluate("shop-1")).resolves.toEqual(expected);
  });

  it.each([
    ["NO_CONTRACT", "CONTRACT_REQUIRED"],
    ["FROZEN", "SUBSCRIPTION_FROZEN"],
    ["UNMAPPED", "UNMAPPED_PLAN"],
    ["SYNC_ERROR", "SYNC_ERROR"],
  ])("preserves the distinct denial reason for %s", async (status, reason) => {
    await expect(service(status).evaluate("shop-1")).resolves.toEqual({
      allowed: false,
      shopId: "shop-1",
      reason,
    });
  });

  it("preserves the shop lifecycle denial independent of subscription state", async () => {
    await expect(service("ACTIVE", "UNINSTALLED").evaluate("shop-1")).resolves.toEqual({
      allowed: false,
      shopId: "shop-1",
      reason: "SHOP_UNAVAILABLE",
    });
  });
  it("allows recovery-only execution after a verified subscribed contract has ended", async () => {
    const eligibility = service("NO_CONTRACT", "ACTIVE", {
      onboardingCompleted: true,
      lastProviderLifecycleState: "CANCELED",
    });

    await expect(
      eligibility.evaluate("shop-1", undefined, "recovery"),
    ).resolves.toEqual({ allowed: true, shopId: "shop-1" });
    await expect(eligibility.evaluate("shop-1")).resolves.toEqual({
      allowed: false,
      shopId: "shop-1",
      reason: "CONTRACT_REQUIRED",
    });
  });

  it("allows Woo FROZEN for recovery only while keeping general execution blocked", async () => {
    const eligibility = service("FROZEN", "ACTIVE", { platform: "WOOCOMMERCE" });

    await expect(eligibility.evaluate("shop-1", undefined, "recovery")).resolves.toEqual({
      allowed: true,
      shopId: "shop-1",
    });
    await expect(eligibility.evaluate("shop-1")).resolves.toEqual({
      allowed: false,
      shopId: "shop-1",
      reason: "SUBSCRIPTION_FROZEN",
    });
  });

  it("does not treat an onboarded merchant that never subscribed as post-contract recovery eligible", async () => {
    const eligibility = service("NO_CONTRACT", "ACTIVE", {
      onboardingCompleted: true,
      lastProviderLifecycleState: null,
    });

    await expect(
      eligibility.evaluate("shop-1", undefined, "recovery"),
    ).resolves.toEqual({
      allowed: false,
      shopId: "shop-1",
      reason: "CONTRACT_REQUIRED",
    });
  });

});
