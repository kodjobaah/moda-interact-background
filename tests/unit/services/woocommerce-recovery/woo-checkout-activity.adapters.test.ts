import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));
vi.mock("../../../../src/lib/redis.js", () => ({ connectionRedis: {} }));

import {
  WooExistingRecoveryRepository,
  WooShopEligibilityRepository,
} from "../../../../src/services/woocommerce-recovery/woo-checkout-activity.adapters.js";

const id = { shopId: "shop-1", checkoutToken: "checkout-1" };
const shop = () => ({
  id: "shop-1", domain: "trusted-store.example.test", status: "ACTIVE", platform: "WOOCOMMERCE",
  shopifyShopId: null, onboardingCompleted: true,
  subscription: { status: "ACTIVE", lastProviderLifecycleState: null },
  wooCommerceInstallation: { status: "ACTIVE", revokedAt: null },
});

describe("BG001 trusted tenant/row adapters", () => {
  it("reads shop domain and active Woo installation only from database", async () => {
    const findUnique = vi.fn(async () => shop());
    const port = new WooShopEligibilityRepository({ shop: { findUnique } } as never);
    expect(await port.evaluate("shop-1")).toEqual({
      allowed: true, shopDomain: "trusted-store.example.test",
    });
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "shop-1" } }));
  });

  it.each([
    { change: { platform: "SHOPIFY" }, reason: "woo_shop_unavailable" },
    { change: { status: "SUSPENDED" }, reason: "woo_shop_unavailable" },
    { change: { onboardingCompleted: false }, reason: "woo_shop_unavailable" },
    { change: { shopifyShopId: "gid://shopify/Shop/1" }, reason: "woo_shop_unavailable" },
    { change: { wooCommerceInstallation: null }, reason: "woo_installation_unavailable" },
    { change: { wooCommerceInstallation: { status: "REVOKED", revokedAt: new Date() } }, reason: "woo_installation_unavailable" },
  ])("denies ineligible installation/shop conditions: $reason", async ({ change, reason }) => {
    const port = new WooShopEligibilityRepository({
      shop: { findUnique: vi.fn(async () => ({ ...shop(), ...change })) },
    } as never);
    expect(await port.evaluate("shop-1")).toEqual({ allowed: false, reason });
  });

  it("looks up the latest generation by exact tenant+checkout and advances only newer activity", async () => {
    const lastExternalActivityAt = new Date("2026-10-24T10:00:00.000Z");
    const findFirst = vi.fn(async () => ({ id: "latest-recovery", generation: 2, status: "DETECTED",
      lastExternalActivityAt, statusHistory: [] }));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const port = new WooExistingRecoveryRepository({
      checkoutRecovery: { findFirst, updateMany },
    } as never);
    expect(await port.findExisting(id)).toEqual({ id: "latest-recovery", generation: 2,
      status: "DETECTED", lastExternalActivityAt, resumption: null, admissionEventId: null });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopId: "shop-1", checkoutToken: "checkout-1" },
      orderBy: [{ generation: "desc" }, { id: "desc" }],
    }));
    const timestamp = new Date("2026-10-24T11:00:00.000Z");
    await port.recordExternalActivity(id, "first-recovery", timestamp);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "first-recovery", shopId: "shop-1", checkoutToken: "checkout-1",
        lastExternalActivityAt: { lt: timestamp },
      },
      data: { lastExternalActivityAt: timestamp },
    });
  });

  it("writes the resumption closure and history only after a successful status CAS", async () => {
    const occurredAt = new Date("2026-10-24T11:00:00.000Z");
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const historyCreate = vi.fn(async () => ({}));
    const transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({
      checkoutRecovery: { updateMany }, checkoutRecoveryStatusHistory: { create: historyCreate },
    }));
    const port = new WooExistingRecoveryRepository({ checkoutRecovery: {}, $transaction: transaction } as never);
    const recovery = { id: "recovery-2", generation: 2, status: "ENGAGED" as const,
      lastExternalActivityAt: new Date("2026-10-24T10:00:00.000Z"), resumption: null, admissionEventId: null };
    expect(await port.closeForResumption({ ref: id, recovery, occurredAt, eventId: "evt-resume", nextGeneration: 3 })).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({ where: {
      id: recovery.id, shopId: id.shopId, checkoutToken: id.checkoutToken, generation: 2,
      status: { in: ["DETECTED", "MESSAGE_SENT", "ENGAGED"] }, lastExternalActivityAt: { lt: occurredAt },
    }, data: { status: "CANCELLED", lastExternalActivityAt: occurredAt } });
    expect(historyCreate).toHaveBeenCalledWith({ data: {
      checkoutRecoveryId: recovery.id, fromStatus: "ENGAGED", toStatus: "CANCELLED",
      source: "woocommerce.checkout", reason: "CHECKOUT_RESUMED",
      metadata: { eventId: "evt-resume", nextGeneration: 3 },
    } });
    updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await port.closeForResumption({ ref: id, recovery, occurredAt, eventId: "evt-race", nextGeneration: 3 })).toBe(false);
    expect(historyCreate).toHaveBeenCalledOnce();
  });
});
