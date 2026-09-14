import { describe, expect, it, vi } from "vitest";
import { ShopExecutionEligibilityService } from "../../../src/services/shop-execution-eligibility.service.js";

function service(status: string | null, shopStatus = "ACTIVE") {
  return new ShopExecutionEligibilityService({
    subscription: {
      findUnique: vi.fn().mockResolvedValue({
        status,
        shop: { status: shopStatus },
      }),
    },
  } as never);
}

describe("ShopExecutionEligibilityService", () => {
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
});