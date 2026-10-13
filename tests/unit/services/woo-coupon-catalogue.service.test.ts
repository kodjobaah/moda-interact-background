import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { WooCouponReadError } from "../../../src/providers/woo-coupon-transport.js";

vi.mock("../../../src/lib/db.js", () => ({ default: { $transaction: vi.fn() } }));
import { WooCouponCatalogueService } from "../../../src/services/woo-coupon-catalogue.service.js";

const REQUESTED = new Date("2026-10-13T12:00:00Z");
const fresh = (id: number, code: string) => ({
  id, code, discount_type: "percent", amount: "10", usage_limit: null,
  usage_count: 0, date_expires_gmt: null,
});

type Discount = {
  shopId: string; shopifyDiscountNodeId: string; isAvailable: boolean;
  providerStatus: string; fixedSelectable: boolean; unavailableAt: Date | null;
  lastSeenSyncGeneration: number; lastSyncedAt: Date;
  singleRedeemCode: string; providerSnapshot: Record<string, unknown>;
};
type Catalogue = {
  shopId: string; status: string; syncGeneration: number; activeSyncToken: string | null;
  syncRequestedAt: Date | null; syncStartedAt: Date | null; lastSuccessfulSyncAt: Date | null;
  lastErrorAt: Date | null; lastErrorCode: string | null; unavailableAt: Date | null;
};
type State = { catalogue: Catalogue; discounts: Discount[]; grantActive: boolean; shopActive: boolean };

function fixture(records: Discount[] = []) {
  let state: State = {
    catalogue: {
      shopId: "woo-a", status: "SYNC_REQUIRED", syncGeneration: 0, activeSyncToken: null,
      syncRequestedAt: REQUESTED, syncStartedAt: null, lastSuccessfulSyncAt: null,
      lastErrorAt: null, lastErrorCode: null, unavailableAt: null,
    },
    discounts: records, grantActive: true, shopActive: true,
  };
  const calls = { upserts: [] as Array<Record<string, unknown>>, updates: [] as Array<Record<string, unknown>>, locks: 0 };
  let failOnId: string | null = null;
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    // Simulates an atomic transaction: if any Prisma operation throws, all writes roll back.
    const candidate = structuredClone(state);
    const tx = {
      $queryRaw: vi.fn().mockImplementation(async () => { calls.locks++; return [{ id: "catalogue" }]; }),
      shop: { findUnique: vi.fn().mockImplementation(async () => candidate.shopActive
        ? { status: "ACTIVE", platform: "WOOCOMMERCE", shopifyShopId: null } : null) },
      wooCommerceInstallation: { findUnique: vi.fn().mockImplementation(async (args: { select?: { restReadGrant?: unknown } }) => {
        if (!candidate.shopActive) return null;
        return args.select?.restReadGrant
          ? { id: "install-a", credentialVersion: 1, restReadGrant: {
            shopId: "woo-a", installationId: "install-a", status: candidate.grantActive ? "ACTIVE" : "REVOKED",
            revokedAt: null, invalidatedAt: null, authorizedScope: "read", credentialVersionSnapshot: 1,
          } }
          : { status: "ACTIVE", revokedAt: null };
      }) },
      shopifyDiscountCatalogue: {
        findUnique: vi.fn().mockImplementation(async () => candidate.catalogue),
        update: vi.fn().mockImplementation(async ({ data }: { data: Partial<Catalogue> }) => {
          Object.assign(candidate.catalogue, data); return candidate.catalogue;
        }),
      },
      shopifyDiscount: {
        upsert: vi.fn().mockImplementation(async ({ where, create, update }: {
          where: { shopId_shopifyDiscountNodeId: { shopId: string; shopifyDiscountNodeId: string } };
          create: Discount; update: Partial<Discount>;
        }) => {
          const key = where.shopId_shopifyDiscountNodeId.shopifyDiscountNodeId;
          calls.upserts.push({ key, create, update });
          if (failOnId === key) throw new Error("db write failed");
          const index = candidate.discounts.findIndex((r) => r.shopifyDiscountNodeId === key);
          if (index < 0) candidate.discounts.push(create);
          else Object.assign(candidate.discounts[index]!, update);
        }),
        updateMany: vi.fn().mockImplementation(async ({ where, data }: {
          where: { shopId: string; lastSeenSyncGeneration: { not: number }; unavailableAt?: null };
          data: Partial<Discount>;
        }) => {
          calls.updates.push({ where, data });
          for (const row of candidate.discounts) {
            if (row.shopId === where.shopId && row.lastSeenSyncGeneration !== where.lastSeenSyncGeneration.not &&
                (where.unavailableAt === undefined || row.unavailableAt === null)) Object.assign(row, data);
          }
        }),
      },
    };
    const result = await callback(tx);
    state = candidate;
    return result;
  });
  const database = { $transaction: transaction } as unknown as PrismaClient;
  return {
    database, transaction, calls, get state() { return state; },
    setGrantActive(value: boolean) { state.grantActive = value; },
    setFailOnId(value: string) { failOnId = value; },
    takeover() { state.catalogue.activeSyncToken = "successor"; state.catalogue.syncGeneration += 1; },
    setCurrent(value: Date) { state.catalogue.lastSuccessfulSyncAt = value; },
  };
}

function oldSelection(): Discount {
  return {
    shopId: "woo-a", shopifyDiscountNodeId: "woo:coupon:12", isAvailable: true,
    providerStatus: "ACTIVE", fixedSelectable: true, unavailableAt: null,
    lastSeenSyncGeneration: 0, lastSyncedAt: REQUESTED,
    singleRedeemCode: "OLD", providerSnapshot: {},
  };
}

describe("ARCH-036 Woo catalogue generation reconciliation", () => {
  it("first scan creates unselected rows and commits CURRENT only after the complete read", async () => {
    const f = fixture();
    const read = vi.fn().mockResolvedValue([fresh(11, "SAVE10")]);
    const service = new WooCouponCatalogueService(f.database, read, () => REQUESTED);
    expect(await service.reconcile("woo-a", REQUESTED)).toBe("current");
    expect(read).toHaveBeenCalledWith("woo-a");
    expect(f.state.catalogue).toMatchObject({ status: "CURRENT", syncGeneration: 1, activeSyncToken: null,
      lastSuccessfulSyncAt: REQUESTED });
    expect(f.state.discounts).toMatchObject([{ shopId: "woo-a", shopifyDiscountNodeId: "woo:coupon:11",
      singleRedeemCode: "SAVE10", isAvailable: false, providerStatus: "ACTIVE", fixedSelectable: true }]);
    expect(f.calls.locks).toBeGreaterThanOrEqual(2);
  });

  it("preserves merchant selection on amount/code changes, expiry and disappearance", async () => {
    const selected = oldSelection();
    const f = fixture([selected]);
    const service = new WooCouponCatalogueService(f.database,
      async () => [fresh(12, "NEWCODE"), fresh(13, "EXPIRING")], () => REQUESTED);
    expect(await service.reconcile("woo-a", REQUESTED)).toBe("current");
    expect(f.state.discounts.find((row) => row.shopifyDiscountNodeId === "woo:coupon:12"))
      .toMatchObject({ isAvailable: true, singleRedeemCode: "NEWCODE", lastSeenSyncGeneration: 1 });
    expect(f.calls.upserts[0]?.update).not.toHaveProperty("isAvailable");

    // Another verified full scan: coupon 12 has disappeared; keep FK and selection.
    const next = new Date("2026-10-13T13:00:00Z");
    f.state.catalogue.syncRequestedAt = next;
    const removing = new WooCouponCatalogueService(f.database,
      async () => [fresh(13, "EXPIRING")], () => next);
    expect(await removing.reconcile("woo-a", next)).toBe("current");
    expect(f.state.discounts.find((row) => row.shopifyDiscountNodeId === "woo:coupon:12"))
      .toMatchObject({ isAvailable: true, providerStatus: "REMOVED", fixedSelectable: false, unavailableAt: next });
    expect(f.calls.updates.every((call) => !Object.hasOwn(call.data, "isAvailable"))).toBe(true);
  });

  it("valid empty catalogue tombstones prior rows without deleting or clearing selections", async () => {
    const f = fixture([oldSelection()]);
    expect(await new WooCouponCatalogueService(f.database, async () => [], () => REQUESTED)
      .reconcile("woo-a", REQUESTED)).toBe("current");
    expect(f.state.discounts[0]).toMatchObject({ isAvailable: true, providerStatus: "REMOVED", fixedSelectable: false });
  });

  it("incomplete/invalid scan records ERROR and leaves prior rows and successful generation intact", async () => {
    const f = fixture([oldSelection()]);
    await expect(new WooCouponCatalogueService(f.database,
      async () => { throw new WooCouponReadError("incomplete_pages"); }, () => REQUESTED)
      .reconcile("woo-a", REQUESTED)).rejects.toThrow("incomplete_pages");
    expect(f.state.catalogue).toMatchObject({ status: "ERROR", activeSyncToken: null,
      lastSuccessfulSyncAt: null, lastErrorCode: "incomplete_pages" });
    expect(f.state.discounts).toEqual([oldSelection()]);
  });

  it("permission failure is non-terminal UNAVAILABLE and does not erase old catalogue", async () => {
    const f = fixture([oldSelection()]);
    expect(await new WooCouponCatalogueService(f.database,
      async () => { throw new WooCouponReadError("grant_missing"); }, () => REQUESTED)
      .reconcile("woo-a", REQUESTED)).toBe("unavailable");
    expect(f.state.catalogue).toMatchObject({ status: "UNAVAILABLE", lastErrorCode: "grant_missing" });
    expect(f.state.discounts).toEqual([oldSelection()]);
  });

  it("rechecks grant before commit and rejects revocation after the provider read", async () => {
    const f = fixture([oldSelection()]);
    expect(await new WooCouponCatalogueService(f.database,
      async () => { f.setGrantActive(false); return [fresh(12, "CHANGED")]; }, () => REQUESTED)
      .reconcile("woo-a", REQUESTED)).toBe("unavailable");
    expect(f.state.discounts).toEqual([oldSelection()]);
    expect(f.state.catalogue.status).toBe("UNAVAILABLE");
  });

  it("rolls back an interrupted reconciliation and reports an error without losing selections", async () => {
    const f = fixture([oldSelection()]);
    f.setFailOnId("woo:coupon:22");
    await expect(new WooCouponCatalogueService(f.database,
      async () => [fresh(12, "CHANGED"), fresh(22, "NEW")], () => REQUESTED)
      .reconcile("woo-a", REQUESTED)).rejects.toThrow("db write failed");
    expect(f.state.discounts).toEqual([oldSelection()]);
    expect(f.state.catalogue).toMatchObject({ status: "ERROR", lastErrorCode: "woo_coupon_sync_error" });
  });

  it("does not commit or mark errors if the generation was superseded", async () => {
    const f = fixture([oldSelection()]);
    expect(await new WooCouponCatalogueService(f.database,
      async () => { f.takeover(); return [fresh(12, "STALE")]; }, () => REQUESTED)
      .reconcile("woo-a", REQUESTED)).toBe("superseded");
    expect(f.state.discounts).toEqual([oldSelection()]);
    expect(f.state.catalogue.activeSyncToken).toBe("successor");
  });

  it("skips a fresh active scan and an already-completed job without requesting coupons", async () => {
    const f = fixture();
    const read = vi.fn();
    f.state.catalogue.status = "SYNCING";
    f.state.catalogue.syncStartedAt = REQUESTED;
    expect(await new WooCouponCatalogueService(f.database, read, () => REQUESTED)
      .reconcile("woo-a", REQUESTED)).toBe("already-running");
    expect(read).not.toHaveBeenCalled();
    f.state.catalogue.status = "CURRENT";
    f.setCurrent(REQUESTED);
    expect(await new WooCouponCatalogueService(f.database, read, () => REQUESTED)
      .reconcile("woo-a", REQUESTED)).toBe("unavailable");
    expect(read).not.toHaveBeenCalled();
  });
});
