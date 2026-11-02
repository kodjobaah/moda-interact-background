import { describe, expect, it, vi } from "vitest";
import { readCurrentDiscountSourceFence } from "../../../../src/services/recovery-offers/current-discount-source-fence.js";

function fixture() {
  const timestamp = new Date("2026-10-31T12:00:00.000Z");
  const catalogue = {
    status: "CURRENT", syncGeneration: 7, activeSyncToken: null,
    lastSuccessfulSyncAt: timestamp, unavailableAt: null,
  };
  const discount = {
    id: "discount-a", shopId: "shop-a", shopifyDiscountNodeId: "gid://discount/1",
    method: "CODE", providerStatus: "ACTIVE", startsAt: null, endsAt: null,
    singleRedeemCode: "SAVE10", codeCount: 1, fixedSelectable: true, isAvailable: true,
    unavailableAt: null, lastSeenSyncGeneration: 7, lastSyncedAt: timestamp,
    updatedAt: timestamp, providerSnapshot: { conditionFacts: { completeness: "COMPLETE" } },
  };
  const tx = {
    shop: { findUnique: vi.fn(async () => ({ id: "shop-a", platform: "SHOPIFY" })) },
    checkoutRecovery: { findFirst: vi.fn(async () => ({ id: "recovery-a", shopId: "shop-a", platform: "SHOPIFY" })) },
    shopifyDiscountCatalogue: { findUnique: vi.fn(async () => catalogue) },
    shopifyDiscount: { findMany: vi.fn(async () => [discount]) },
  };
  const database = {
    $transaction: vi.fn(async (callback, options) => {
      expect(options).toMatchObject({ isolationLevel: "RepeatableRead", maxWait: 2_000, timeout: 10_000 });
      return callback(tx);
    }),
  };
  return { tx, database, catalogue, discount };
}

const input = () => ({
  shopId: "shop-a", checkoutRecoveryId: "recovery-a", selectedOfferIds: ["discount-a"],
  signal: new AbortController().signal,
});

describe("current discount source fence", () => {
  it("creates a repeatable digest for current same-shop source rows", async () => {
    const { database, tx } = fixture();
    const result = await readCurrentDiscountSourceFence(input(), {
      database: database as unknown as Parameters<typeof readCurrentDiscountSourceFence>[1] extends { database?: infer T } ? T : never,
      clock: () => 1,
    });
    expect(result.kind).toBe("AVAILABLE");
    if (result.kind !== "AVAILABLE") return;
    expect(result.fence).toMatchObject({ shopId: "shop-a", platform: "SHOPIFY", syncGeneration: 7,
      selectedOfferIds: ["discount-a"] });
    expect(result.fence.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(database.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.shopifyDiscount.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopId: "shop-a", id: { in: ["discount-a"] } },
    }));
  });

  it("fails closed when a selected row was not observed in the current generation", async () => {
    const { database, discount } = fixture();
    discount.lastSeenSyncGeneration = 6;
    const result = await readCurrentDiscountSourceFence(input(), {
      database: database as unknown as Parameters<typeof readCurrentDiscountSourceFence>[1] extends { database?: infer T } ? T : never,
      clock: () => 1,
    });
    expect(result).toEqual({ kind: "UNAVAILABLE", reasonCode: "SOURCE_ROW_UNAVAILABLE" });
  });

  it("changes the digest when persisted source facts change", async () => {
    const { database, discount } = fixture();
    const first = await readCurrentDiscountSourceFence(input(), {
      database: database as unknown as Parameters<typeof readCurrentDiscountSourceFence>[1] extends { database?: infer T } ? T : never,
      clock: () => 1,
    });
    discount.singleRedeemCode = "SAVE11";
    const second = await readCurrentDiscountSourceFence(input(), {
      database: database as unknown as Parameters<typeof readCurrentDiscountSourceFence>[1] extends { database?: infer T } ? T : never,
      clock: () => 1,
    });
    expect(first.kind).toBe("AVAILABLE");
    expect(second.kind).toBe("AVAILABLE");
    if (first.kind === "AVAILABLE" && second.kind === "AVAILABLE") {
      expect(second.fence.snapshotDigest).not.toBe(first.fence.snapshotDigest);
    }
  });

  it("rejects malformed or duplicate proposed IDs before opening a transaction", async () => {
    const { database } = fixture();
    const result = await readCurrentDiscountSourceFence({ ...input(), selectedOfferIds: ["discount-a", "discount-a"] }, {
      database: database as unknown as Parameters<typeof readCurrentDiscountSourceFence>[1] extends { database?: infer T } ? T : never,
    });
    expect(result).toEqual({ kind: "UNAVAILABLE", reasonCode: "INVALID_INPUT" });
    expect(database.$transaction).not.toHaveBeenCalled();
  });
});