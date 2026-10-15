import { describe, expect, it, vi } from "vitest";
import { RecoveryPolicyService } from "../../../src/services/recovery-policy.service.js";

vi.mock("../../../src/lib/db.js", () => ({ default: {} }));

const NOW = new Date("2026-10-15T15:00:00Z");
const shopId = "woo-shop-123";
const discount = (overrides: Record<string, unknown> = {}) => ({
  id: "db-discount-1", shopId, shopifyDiscountNodeId: "woo:coupon:99",
  method: "CODE", providerStatus: "ACTIVE", fixedSelectable: true,
  isAvailable: true, unavailableAt: null, singleRedeemCode: "MERCHANTCHOICE",
  title: "MERCHANTCHOICE", summary: "custom", startsAt: null,
  endsAt: null, providerSnapshot: { provider: "WOOCOMMERCE", discountType: "plugin-type" },
  catalogue: { status: "CURRENT", lastSuccessfulSyncAt: new Date("2026-10-15T12:00:00Z") },
  ...overrides,
});
const settings = (d: Record<string, unknown> | null) => ({
  recoveryDelayMinutes: 30, recoveryOfferMode: "FIXED", fixedShopifyDiscountId: "db-discount-1",
  followUpEnabled: false, followUpDelayMinutes: null, fixedShopifyDiscount: d,
});

function fixture(platform: "WOOCOMMERCE" | "SHOPIFY", row: Record<string, unknown> | null) {
  const db = {
    shop: { findUnique: vi.fn().mockResolvedValue({ platform }) },
    shopSettings: { findUnique: vi.fn().mockResolvedValue(settings(row)) },
    shopRecoveryPolicyOverride: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  return { db, policy: new RecoveryPolicyService(db as never) };
}

describe("ARCH-036 BACKGROUND-005 Woo selected coupon policy", () => {
  it("keeps the Woo FIXED snapshot despite unknown type, zero amount, expired usage and catalogue ERROR", async () => {
    const row = discount({
      fixedSelectable: false, providerStatus: "EXPIRED", endsAt: new Date("2026-01-01T00:00:00Z"),
      providerSnapshot: { provider: "WOOCOMMERCE", discountType: "plugin_custom", amount: "0", usageCount: 10, usageLimit: 1 },
      catalogue: { status: "ERROR", lastSuccessfulSyncAt: new Date("2026-10-13T12:00:00Z") },
    });
    const { policy, db } = fixture("WOOCOMMERCE", row);
    const result = await policy.resolve(shopId, NOW);
    expect(result.offerSnapshot).toMatchObject({
      id: "db-discount-1", singleRedeemCode: "MERCHANTCHOICE",
    });
    expect(db.shop.findUnique).toHaveBeenCalledWith({ where: { id: shopId }, select: { platform: true } });
  });

  it.each([
    { label: "merchant opted out", changes: { isAvailable: false } },
    { label: "confirmed REMOVED", changes: { providerStatus: "REMOVED" } },
    { label: "removed timestamp", changes: { unavailableAt: new Date("2026-10-14T12:00:00Z") } },
    { label: "missing redeem code", changes: { singleRedeemCode: null } },
    { label: "unsafe redeem code", changes: { singleRedeemCode: "a\nb" } },
    { label: "never successfully observed", changes: { catalogue: { status: "ERROR", lastSuccessfulSyncAt: null } } },
    { label: "different shop", changes: { shopId: "someone-else" } },
    { label: "non-Woo provider ID", changes: { shopifyDiscountNodeId: "gid://shopify/Discount/123" } },
  ])("will not send $label", async ({ changes }) => {
    const { policy } = fixture("WOOCOMMERCE", discount(changes));
    expect((await policy.resolve(shopId, NOW)).offerSnapshot).toBeNull();
  });

  it("preserves Shopify's expiry, provider status, fixedSelectable and CURRENT gating", async () => {
    const base = discount({
      shopifyDiscountNodeId: "gid://shopify/Discount/123", providerStatus: "ACTIVE",
    });
    const cases = [
      { providerStatus: "EXPIRED" }, { fixedSelectable: false },
      { endsAt: new Date("2026-01-01T00:00:00Z") },
      { catalogue: { status: "ERROR", lastSuccessfulSyncAt: NOW } },
      { startsAt: new Date("2026-11-01T00:00:00Z") },
      { isAvailable: false },
    ];
    expect((await fixture("SHOPIFY", base).policy.resolve(shopId, NOW)).offerSnapshot)
      .toMatchObject({ id: "db-discount-1" });
    for (const changes of cases) {
      expect((await fixture("SHOPIFY", { ...base, ...changes }).policy.resolve(shopId, NOW)).offerSnapshot)
        .toBeNull();
    }
  });
});
