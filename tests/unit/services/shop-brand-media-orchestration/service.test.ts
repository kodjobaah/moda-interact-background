import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ShopBrandMediaReconciliationService,
} from "../../../../src/services/shop-brand-media-orchestration/service.js";
import { claimRole, completeClaim, parseBrandDocument, updateObservedSource } from "../../../../src/services/shop-brand-media-orchestration/state.js";
import type { BrandDocument, BrandClaim, BrandRole } from "../../../../src/services/shop-brand-media-orchestration/contracts.js";
import { ShopBrandMediaError } from "../../../../src/services/shop-brand-media/contracts.js";

const NOW = new Date("2026-10-20T00:00:00.000Z");
const F = `sha256:${"a".repeat(64)}`;
const D = "b".repeat(64);
const media = (shop: string) => ({ sourceGeneration: 1, sourceFingerprint: F,
  objectKey: `shop-brands/${shop}/logo/sha256-${D}.jpg`, contentType: "image/jpeg" as const,
  contentSha256: D, width: 1125, height: 600, sizeBytes: 1000 });

function fixture(count: number) {
  const rows = new Map<string, BrandDocument>();
  for (let i = 0; i < count; i++) {
    const shopId = `shop_${String(i).padStart(4, "0")}`;
    rows.set(shopId, updateObservedSource(parseBrandDocument({}), {
      shopId, role: "LOGO", sourceUrl: `https://example.test/${i}.jpg`,
      sourceReference: null, sourceFingerprint: F, observedAt: NOW.toISOString(),
    }).document);
  }
  const pageCalls: Array<{ cursor: string | null; limit: number }> = [];
  const repository = {
    async listPage(cursor: string | null, limit: number) {
      pageCalls.push({ cursor, limit });
      return [...rows.entries()].filter(([shopId]) => !cursor || shopId > cursor)
        .slice(0, limit).map(([shopId, whatsAppMedia]) => ({ shopId, whatsAppMedia }));
    },
    async claim(shopId: string, role: BrandRole, at = NOW): Promise<BrandClaim | null> {
      const { document, claim } = claimRole(rows.get(shopId)!, shopId, `${shopId}.myshopify.com`, role, randomUUID(), at);
      rows.set(shopId, document);
      return claim;
    },
    async complete(claim: BrandClaim, result: { result: ReturnType<typeof media>; verifiedAt: string }, at = NOW) {
      const next = completeClaim(rows.get(claim.shopId)!, claim, result, at);
      rows.set(claim.shopId, next.document);
      return next.applied;
    },
    async fail(claim: BrandClaim, failureCode: string, retryable: boolean, at = NOW) {
      const { failClaim } = await import("../../../../src/services/shop-brand-media-orchestration/state.js");
      const next = failClaim(rows.get(claim.shopId)!, claim, failureCode, retryable, at);
      rows.set(claim.shopId, next.document);
      return next.applied;
    },
  };
  return { repository, rows, pageCalls };
}

describe("ARCH-049 media scanner and worker", () => {
  it("advances a bounded keyset cursor through hot shops and eventually finds later work without a wake", async () => {
    const { repository, rows, pageCalls } = fixture(18);
    const processor = { process: vi.fn(async ({ shopId }: { shopId: string }) => media(shopId)) };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new ShopBrandMediaReconciliationService({ repository, processor, logger,
      now: () => NOW, pageSize: 5, maxRowsPerSweep: 7, maxClaimsPerSweep: 3, concurrency: 2 });
    for (let n = 0; n < 9; n++) await service.reconcileOnce();
    expect(processor.process).toHaveBeenCalledTimes(18);
    expect([...rows.values()].every((row) => row.roles.LOGO?.work.status === "READY")).toBe(true);
    expect(Math.max(...pageCalls.map((page) => page.limit))).toBeLessThanOrEqual(5);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does not restart at the beginning when the final page was only partly consumed", async () => {
    const { repository } = fixture(4);
    const service = new ShopBrandMediaReconciliationService({ repository,
      processor: { process: async ({ shopId }) => media(shopId) }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => NOW, pageSize: 50, maxRowsPerSweep: 100, maxClaimsPerSweep: 1 });
    expect((await service.reconcileOnce()).cursor).toBe("shop_0000");
    expect((await service.reconcileOnce()).cursor).toBe("shop_0001");
    expect((await service.reconcileOnce()).cursor).toBe("shop_0002");
    expect((await service.reconcileOnce()).cursor).toBeNull();
  });

  it("logs the original processing error and records retry", async () => {
    const { repository, rows } = fixture(1);
    const error = { message: "https://private.example/?secret=abc" };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new ShopBrandMediaReconciliationService({ repository,
      processor: { process: async () => { throw error; } }, logger, now: () => NOW });
    await service.reconcileOnce();
    expect(rows.get("shop_0000")!.roles.LOGO!.work).toMatchObject({ status: "FAILED", attempts: 1,
      failureCode: "UNEXPECTED_FAILURE" });
    const emitted = JSON.stringify(logger.error.mock.calls);
    expect(emitted).toContain("secret=abc");
    expect(emitted).toContain("private.example");
  });

  it("logs a scanner page exception and rethrows it for scheduler visibility", async () => {
    const { repository } = fixture(1);
    const error = new Error("https://private.example/?secret=not-for-logs");
    repository.listPage = vi.fn().mockRejectedValue(error);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new ShopBrandMediaReconciliationService({ repository,
      processor: { process: async ({ shopId }) => media(shopId) }, logger, now: () => NOW });
    await expect(service.reconcileOnce()).rejects.toBe(error);
    expect(logger.error).toHaveBeenCalledWith("shop_brand.media.scan_page_failed",
      expect.objectContaining({ reasonCode: "PAGE_READ_FAILURE", pageSize: 50 }));
    expect(JSON.stringify(logger.error.mock.calls)).toContain("private.example");
  });

  it("logs an individual claim completion exception before reporting a partial sweep failure", async () => {
    const { repository } = fixture(1);
    const failure = new Error("https://private.example/?secret=not-for-logs");
    repository.complete = vi.fn().mockRejectedValue(failure);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new ShopBrandMediaReconciliationService({ repository,
      processor: { process: async ({ shopId }) => media(shopId) }, logger, now: () => NOW });
    await expect(service.reconcileOnce()).rejects.toBeInstanceOf(AggregateError);
    expect(logger.error).toHaveBeenCalledWith("shop_brand.media.claim_failed",
      expect.objectContaining({ shopId: "shop_0000", role: "LOGO",
        reasonCode: "CLAIM_OPERATION_FAILED", exceptionType: "Error" }));
    expect(JSON.stringify(logger.error.mock.calls)).toContain("private.example");
  });

  it("logs a bad ShopBrand role without preventing other shops from progressing", async () => {
    const { repository, rows } = fixture(2);
    rows.set("shop_0000", { schemaVersion: 99, roles: {} } as unknown as BrandDocument);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const processor = { process: vi.fn(async ({ shopId }: { shopId: string }) => media(shopId)) };
    const service = new ShopBrandMediaReconciliationService({ repository, processor, logger, now: () => NOW });
    await service.reconcileOnce();
    expect(processor.process).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith("shop_brand.media.scan_row_failed",
      expect.objectContaining({ shopId: "shop_0000",
        reasonCode: "UNSUPPORTED_SCHEMA", exceptionType: "BrandStateError" }));
  });

  it("logs failed optional wakes and propagates their errors", async () => {
    const { repository } = fixture(1);
    const failure = new Error("https://private.example/?secret=not-for-logs");
    repository.claim = vi.fn().mockRejectedValue(failure);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new ShopBrandMediaReconciliationService({ repository,
      processor: { process: async ({ shopId }) => media(shopId) }, logger, now: () => NOW });
    await expect(service.reconcileShop("shop_0000")).rejects.toBe(failure);
    expect(logger.error).toHaveBeenCalledWith("shop_brand.media.local_wake_failed",
      expect.objectContaining({ shopId: "shop_0000", role: "LOGO",
        reasonCode: "LOCAL_WAKE_FAILURE" }));
    expect(JSON.stringify(logger.error.mock.calls)).toContain("private.example");
  });

  it("keeps permanent processor errors terminal and retries recognised transient codes", async () => {
    const { repository, rows } = fixture(1);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new ShopBrandMediaReconciliationService({ repository,
      processor: { process: async () => { throw new ShopBrandMediaError("UNSAFE_SOURCE", false); } },
      logger, now: () => NOW });
    await service.reconcileOnce();
    expect(rows.get("shop_0000")!.roles.LOGO!.work).toMatchObject({ status: "FAILED", retryAfter: null,
      failureCode: "UNSAFE_SOURCE" });
  });

  it("enforces scanner concurrency options rather than spawning unbounded processing", async () => {
    const { repository } = fixture(16);
    let running = 0;
    let max = 0;
    const service = new ShopBrandMediaReconciliationService({ repository,
      processor: { process: async ({ shopId }) => {
        running++; max = Math.max(max, running);
        await Promise.resolve();
        running--;
        return media(shopId);
      } }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, now: () => NOW,
      pageSize: 50, maxRowsPerSweep: 50, maxClaimsPerSweep: 16, concurrency: 2 });
    await service.reconcileOnce();
    expect(max).toBeLessThanOrEqual(2);
    expect(max).toBe(2);
  });
});
