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
    expect(jobs[0]?.opts?.jobId).toBe(createWooCouponJobId("one"));
    expect(jobs[0]?.opts?.removeOnComplete).toBe(true);
    expect(jobs[1]?.opts?.jobId).not.toBe(jobs[0]?.opts?.jobId);
    expect(jobs[0]?.data).not.toHaveProperty("credentials");
    expect(jobs[0]?.data).not.toHaveProperty("siteUrl");
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
    expect(h.queryRaw).toHaveBeenCalledOnce();
    expect(h.addBulk).toHaveBeenCalledOnce();
  });
});
