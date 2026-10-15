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
  singleRedeemCode: string | null; providerSnapshot: Record<string, unknown>;
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
          where: { shopId: string; lastSeenSyncGeneration: { not: number };
            lastSyncedAt?: { lt: Date }; unavailableAt?: null };
          data: Partial<Discount>;
        }) => {
          calls.updates.push({ where, data });
          for (const row of candidate.discounts) {
            if (row.shopId === where.shopId && row.lastSeenSyncGeneration !== where.lastSeenSyncGeneration.not &&
                (where.lastSyncedAt === undefined || row.lastSyncedAt < where.lastSyncedAt.lt) &&
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

    // First complete scan without coupon 12 retains status, FK and selection.
    const next = new Date("2026-10-13T13:00:00Z");
    f.state.catalogue.syncRequestedAt = next;
    expect(await new WooCouponCatalogueService(f.database,
      async () => [fresh(13, "EXPIRING")], () => next).reconcile("woo-a", next)).toBe("current");
    expect(f.state.discounts.find((row) => row.shopifyDiscountNodeId === "woo:coupon:12"))
      .toMatchObject({ isAvailable: true, providerStatus: "ACTIVE", fixedSelectable: true, unavailableAt: null });

    // Second CONSECUTIVE verified complete absence confirms removal.
    const confirmed = new Date("2026-10-13T14:00:00Z");
    f.state.catalogue.syncRequestedAt = confirmed;
    expect(await new WooCouponCatalogueService(f.database,
      async () => [fresh(13, "EXPIRING")], () => confirmed).reconcile("woo-a", confirmed)).toBe("current");
    expect(f.state.discounts.find((row) => row.shopifyDiscountNodeId === "woo:coupon:12"))
      .toMatchObject({ isAvailable: true, providerStatus: "REMOVED", fixedSelectable: false, unavailableAt: confirmed });
    expect(f.calls.updates.every((call) => !Object.hasOwn(call.data, "isAvailable"))).toBe(true);
  });

  it("empty catalogue requires two complete misses; intervening failed attempts do not count", async () => {
    const f = fixture();
    const scan = async (time: Date, coupons: Record<string, unknown>[]) => {
      f.state.catalogue.syncRequestedAt = time;
      return new WooCouponCatalogueService(f.database, async () => coupons, () => time)
        .reconcile("woo-a", time);
    };
    expect(await scan(REQUESTED, [fresh(12, "SAVE10")])).toBe("current");
    f.state.discounts[0]!.isAvailable = true;
    const firstMiss = new Date("2026-10-13T13:00:00Z");
    expect(await scan(firstMiss, [])).toBe("current");
    expect(f.state.discounts[0]).toMatchObject({
      isAvailable: true, providerStatus: "ACTIVE", fixedSelectable: true, unavailableAt: null,
    });
    const failure = new Date("2026-10-13T14:00:00Z");
    f.state.catalogue.syncRequestedAt = failure;
    await expect(new WooCouponCatalogueService(f.database,
      async () => { throw new WooCouponReadError("incomplete_pages"); }, () => failure)
      .reconcile("woo-a", failure)).rejects.toThrow("incomplete_pages");
    expect(f.state.discounts[0]?.providerStatus).toBe("ACTIVE");
    const secondMiss = new Date("2026-10-13T15:00:00Z");
    expect(await scan(secondMiss, [])).toBe("current");
    expect(f.state.discounts[0]).toMatchObject({
      isAvailable: true, providerStatus: "REMOVED", fixedSelectable: false, unavailableAt: secondMiss,
    });
    // Reappearing under the same Woo ID restores provider availability but not selection.
    const reappeared = new Date("2026-10-13T16:00:00Z");
    expect(await scan(reappeared, [fresh(12, "SAVE15")])).toBe("current");
    expect(f.state.discounts[0]).toMatchObject({
      isAvailable: true, providerStatus: "ACTIVE", fixedSelectable: true,
      singleRedeemCode: "SAVE15", unavailableAt: null,
    });
    const missedAgain = new Date("2026-10-13T17:00:00Z");
    expect(await scan(missedAgain, [])).toBe("current");
    expect(f.state.discounts[0]?.providerStatus).toBe("ACTIVE");
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

  it("commits CURRENT with five ordinary coupons and one malformed optional coupon", async () => {
    const f = fixture();
    const reporter = { warn: vi.fn() };
    const read = async () => [
      ...[1, 2, 3, 4, 5].map((id) => fresh(id, `SAVE${id}`)),
      { ...fresh(6, "UNFAMILIAR"), discount_type: "plugin-defined", amount: "0",
        usage_limit: "unknown", date_expires_gmt: "invalid-date", product_ids: ["oops"] },
    ];
    const service = new WooCouponCatalogueService(f.database, read, () => REQUESTED, undefined, reporter);
    expect(await service.reconcile("woo-a", REQUESTED)).toBe("current");
    expect(f.state.catalogue.status).toBe("CURRENT");
    expect(f.state.discounts).toHaveLength(6);
    expect(f.state.discounts.find((r) => r.shopifyDiscountNodeId === "woo:coupon:6"))
      .toMatchObject({ singleRedeemCode: "UNFAMILIAR", fixedSelectable: true,
        providerStatus: "ACTIVE", isAvailable: false });
    expect(reporter.warn).toHaveBeenCalledWith("woo.coupon_sync.item_issues", expect.objectContaining({
      shopId: "woo-a", observedCount: 6, issueCount: 3,
    }));
    const logs = JSON.stringify(reporter.warn.mock.calls);
    expect(logs).not.toContain("UNFAMILIAR");
  });

  it("keeps a selected coupon observed when its code disappears and restores deliverability later", async () => {
    const f = fixture([oldSelection()]);
    const scan = async (time: Date, entries: Record<string, unknown>[]) => {
      f.state.catalogue.syncRequestedAt = time;
      return new WooCouponCatalogueService(f.database, async () => entries, () => time)
        .reconcile("woo-a", time);
    };
    expect(await scan(REQUESTED, [fresh(12, "OLD")])).toBe("current");
    const missingCode = new Date("2026-10-13T13:00:00Z");
    expect(await scan(missingCode, [{ ...fresh(12, "OLD"), code: "BAD\nHEADER" }])).toBe("current");
    expect(f.state.discounts[0]).toMatchObject({
      isAvailable: true, providerStatus: "UNDELIVERABLE", fixedSelectable: false,
      singleRedeemCode: null, lastSeenSyncGeneration: 2, unavailableAt: null,
    });
    expect(await scan(new Date("2026-10-13T14:00:00Z"), [
      { ...fresh(12, "OLD"), code: null },
    ])).toBe("current");
    expect(f.state.discounts[0]).toMatchObject({
      isAvailable: true, providerStatus: "UNDELIVERABLE", unavailableAt: null,
    });
    const recovered = new Date("2026-10-13T15:00:00Z");
    const longCode = "CODE" + "x".repeat(350);
    expect(await scan(recovered, [fresh(12, longCode)])).toBe("current");
    expect(f.state.discounts[0]).toMatchObject({
      isAvailable: true, providerStatus: "ACTIVE", fixedSelectable: true,
      singleRedeemCode: longCode, unavailableAt: null,
    });
    expect(f.calls.upserts.every((call) => !Object.hasOwn(call.update as object, "isAvailable"))).toBe(true);
  });

  it("does not report a stale generation as CURRENT or emit false diagnostics", async () => {
    const f = fixture();
    const reporter = { warn: vi.fn() };
    const service = new WooCouponCatalogueService(f.database,
      async () => { f.takeover(); return [{ ...fresh(1, "CODE"), usage_count: "bad" }]; },
      () => REQUESTED, undefined, reporter);
    expect(await service.reconcile("woo-a", REQUESTED)).toBe("superseded");
    expect(f.state.discounts).toHaveLength(0);
    expect(reporter.warn).not.toHaveBeenCalled();
  });

  it("treats provider ID corruption as an atomic whole-scan failure", async () => {
    const f = fixture([oldSelection()]);
    const reporter = { warn: vi.fn() };
    await expect(new WooCouponCatalogueService(f.database,
      async () => [fresh(12, "CODE"), { ...fresh(15, "OTHER"), id: 12 }],
      () => REQUESTED, undefined, reporter)
      .reconcile("woo-a", REQUESTED)).rejects.toThrow("provider_identity_invalid");
    expect(f.state.catalogue).toMatchObject({ status: "ERROR", lastErrorCode: "provider_identity_invalid" });
    expect(f.state.discounts).toEqual([oldSelection()]);
    expect(reporter.warn).not.toHaveBeenCalled();
  });
});
