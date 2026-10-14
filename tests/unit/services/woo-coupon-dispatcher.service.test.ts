import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import {
  WooCouponDispatcherService,
  WOO_COUPON_SYNC_JOB_NAME,
  createWooCouponJobId,
} from "../../../src/services/woo-coupon-dispatcher.service.js";

function harness(options: {
  missing?: string[];
  reserved?: Array<{ shopId: string; requestedAt: Date }>;
  failure?: boolean;
} = {}) {
  const findMany = vi.fn().mockResolvedValue((options.missing ?? []).map((id) => ({ id })));
  const createMany = vi.fn().mockResolvedValue({ count: options.missing?.length ?? 0 });
  const queryRaw = vi.fn().mockResolvedValue(options.reserved ?? []);
  const addBulk = options.failure
    ? vi.fn().mockRejectedValue(new Error("redis down"))
    : vi.fn().mockResolvedValue([]);
  const database = {
    shop: { findMany },
    shopifyDiscountCatalogue: { createMany },
    $queryRaw: queryRaw,
  } as unknown as PrismaClient;
  const service = new WooCouponDispatcherService(database, { addBulk } as unknown as Queue);
  return { service, findMany, createMany, queryRaw, addBulk };
}

describe("ARCH-036 Woo coupon leased dispatcher", () => {
  it("bootstraps installed shops without requiring a REST grant", async () => {
    const h = harness({ missing: ["woo-shop-a", "woo-shop-b"] });
    expect(await h.service.dispatch()).toEqual({ cataloguesCreated: 2, shopsReserved: 0, jobsPublished: 0 });
    expect(h.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        platform: "WOOCOMMERCE",
        status: "ACTIVE",
        wooCommerceInstallation: { is: { status: "ACTIVE", revokedAt: null } },
        discountCatalogue: { is: null },
      },
      take: 500,
    }));
    expect(h.createMany).toHaveBeenCalledWith({
      data: [
        { shopId: "woo-shop-a", status: "SYNC_REQUIRED" },
        { shopId: "woo-shop-b", status: "SYNC_REQUIRED" },
      ],
      skipDuplicates: true,
    });
  });

  it("publishes independent bounded jobs with deterministic identities", async () => {
    const requestedAt = new Date("2026-10-13T12:00:00Z");
    const h = harness({ reserved: [
      { shopId: "one", requestedAt },
      { shopId: "two", requestedAt },
    ] });
    expect(await h.service.dispatch(2)).toEqual({ cataloguesCreated: 0, shopsReserved: 2, jobsPublished: 2 });
    const [jobs] = h.addBulk.mock.calls[0] as [Array<{
      name: string;
      data: Record<string, unknown>;
      opts: { jobId: string; removeOnComplete: boolean };
    }>];
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.data).toEqual({ shopId: "one", requestedAt: requestedAt.toISOString() });
    expect(jobs[0]?.name).toBe(WOO_COUPON_SYNC_JOB_NAME);
    expect(jobs[0]?.opts?.jobId).toBe(createWooCouponJobId("one", requestedAt.toISOString()));
    expect(jobs[0]?.opts?.removeOnComplete).toBe(true);
    expect(jobs[1]?.opts?.jobId).not.toBe(jobs[0]?.opts?.jobId);
    expect(jobs[0]?.data).not.toHaveProperty("credentials");
    expect(jobs[0]?.data).not.toHaveProperty("siteUrl");
  });

  it("uses a distinct job ID for each reservation but an identical ID on reservation replay", () => {
    const first = "2026-10-13T12:00:00.000Z";
    const second = "2026-10-13T12:06:00.000Z";
    const original = createWooCouponJobId("one", first);
    expect(createWooCouponJobId("one", first)).toBe(original);
    expect(createWooCouponJobId("one", second)).not.toBe(original);
    expect(createWooCouponJobId("two", first)).not.toBe(original);
    expect(original).toMatch(/^woo-coupon-[a-f0-9]{64}$/);
  });

  it("reserves due shops using SQL row locking, cooldown and provider isolation", async () => {
    const h = harness();
    await h.service.dispatch(9);
    const raw = h.queryRaw.mock.calls[0]?.[0] as { sql?: unknown; strings?: unknown };
    const sql = String(raw.sql ?? raw.strings ?? "");
    for (const fragment of [
      '"ShopifyDiscountCatalogue"', '"WooCommerceInstallation"',
      'FOR UPDATE OF c SKIP LOCKED', '"syncRequestedAt" = NOW()',
      '"lastSuccessfulSyncAt"', '"lastErrorAt"', '"syncStartedAt"',
      `"platform" = 'WOOCOMMERCE'`, `"status" = 'ACTIVE'`,
    ]) expect(sql).toContain(fragment);
  });

  it("rejects invalid batch sizes before touching the database", async () => {
    const h = harness();
    await expect(h.service.dispatch(0)).rejects.toThrow(RangeError);
    await expect(h.service.dispatch(501)).rejects.toThrow(RangeError);
    await expect(h.service.dispatch(3.14)).rejects.toThrow(RangeError);
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it("fails visibly if Redis publication fails; timestamp reservation permits retry after cooldown", async () => {
    const h = harness({ failure: true, reserved: [{ shopId: "one", requestedAt: new Date() }] });
    await expect(h.service.dispatch()).rejects.toThrow("redis down");
    // Dispatch reservation and best-effort reporting each issue a SQL query,
    // including when Redis fails. Reporting must not swallow that failure.
    expect(h.queryRaw).toHaveBeenCalledTimes(2);
    expect(String(h.queryRaw.mock.calls[0]?.[0]?.strings ?? "")).toContain("FOR UPDATE OF c SKIP LOCKED");
    expect(String(h.queryRaw.mock.calls[1]?.[0]?.strings ?? "")).toContain('"oldestDueSeconds"');
    expect(h.addBulk).toHaveBeenCalledOnce();
  });
});

describe("ARCH-036 bounded dispatcher reporting", () => {
  it("reports bounded due/backlog data without exposing shop identities", async () => {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const database = {
      shop: { findMany: vi.fn().mockResolvedValue([{ id: "one" }]) },
      shopifyDiscountCatalogue: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ shopId: "one", requestedAt: new Date("2026-10-13T12:00:00Z") }])
        .mockResolvedValueOnce([{ backlog: 3, oldestDueSeconds: 93.2 }]),
    } as unknown as PrismaClient;
    const queue = { addBulk: vi.fn().mockResolvedValue([]) } as unknown as Queue;
    const { loadWooCouponSyncConfig } = await import("../../../src/services/woo-coupon-sync-config.js");
    const settings = loadWooCouponSyncConfig({ WOO_COUPON_SYNC_DISPATCH_BATCH_SIZE: "2" });
    const reporting = {
      info: (event: string, fields: Record<string, unknown>) => { events.push({ event, fields }); },
      warn: vi.fn(),
    };
    const service = new WooCouponDispatcherService(database, queue, settings, reporting as never);
    expect(await service.dispatch()).toEqual({ cataloguesCreated: 1, shopsReserved: 1, jobsPublished: 1 });
    expect(events).toEqual([{
      event: "woo.coupon_sync.dispatch_cycle",
      fields: {
        cataloguesCreated: 1, discovered: 1, reserved: 1, published: 1,
        dueEstimate: 4, backlog: 3, oldestDueSeconds: 93,
      },
    }]);
    expect(JSON.stringify(events)).not.toContain("woo.example");
    // The two queries are separate snapshots. Neither an observed scan count nor
    // a skipped count is available, even when the backlog query succeeds.
    expect(events[0]?.fields).not.toHaveProperty("scanned");
    expect(events[0]?.fields).not.toHaveProperty("due");
    expect(events[0]?.fields).not.toHaveProperty("skipped");
  });

  it("reports no due estimate when the independent backlog query fails", async () => {
    const events: Array<Record<string, unknown>> = [];
    const database = {
      shop: { findMany: vi.fn().mockResolvedValue([]) },
      shopifyDiscountCatalogue: { createMany: vi.fn() },
      $queryRaw: vi.fn().mockResolvedValueOnce([{ shopId: "one", requestedAt: new Date() }])
        .mockRejectedValueOnce(new Error("reporting unavailable")),
    } as unknown as PrismaClient;
    const addBulk = vi.fn().mockResolvedValue([]);
    const { loadWooCouponSyncConfig } = await import("../../../src/services/woo-coupon-sync-config.js");
    const service = new WooCouponDispatcherService(database, { addBulk } as unknown as Queue,
      loadWooCouponSyncConfig({}),
      { info: (_event: string, fields: Record<string, unknown>) => { events.push(fields); }, warn: vi.fn() } as never);
    expect(await service.dispatch()).toMatchObject({ shopsReserved: 1, jobsPublished: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reserved: 1, published: 1, dueEstimate: null, backlog: null, oldestDueSeconds: null,
    });
    expect(events[0]).not.toHaveProperty("scanned");
    expect(events[0]).not.toHaveProperty("skipped");
  });

  it("does not let telemetry SQL or logging failure affect published jobs", async () => {
    const { loadWooCouponSyncConfig } = await import("../../../src/services/woo-coupon-sync-config.js");
    const database = {
      shop: { findMany: vi.fn().mockResolvedValue([]) },
      shopifyDiscountCatalogue: { createMany: vi.fn() },
      $queryRaw: vi.fn().mockResolvedValueOnce([{ shopId: "one", requestedAt: new Date() }])
        .mockRejectedValueOnce(new Error("monitoring failed")),
    } as unknown as PrismaClient;
    const addBulk = vi.fn().mockResolvedValue([]);
    const service = new WooCouponDispatcherService(database, { addBulk } as unknown as Queue,
      loadWooCouponSyncConfig({}), { info: () => { throw new Error("logger down"); }, warn: vi.fn() } as never);
    expect(await service.dispatch()).toMatchObject({ shopsReserved: 1, jobsPublished: 1 });
    expect(addBulk).toHaveBeenCalledOnce();
  });
});
