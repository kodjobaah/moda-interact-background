import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { parseBrandDocument } from "../shop-brand-media-orchestration/state.js";
import type { ShopifyShopScanRow } from "../shop-brand-media-orchestration/repository.js";
import {
  ShopifyBrandSyncError, type ShopifyBrandFailureCode, type ShopifyBrandSnapshot,
  type ShopifyBrandSyncClaim,
} from "./contracts.js";
import type { ShopifyBrandReader } from "./reader.js";

export interface ShopifyBrandSyncRepository {
  listShopifyShopsPage(afterShopId: string | null, limit: number): Promise<ShopifyShopScanRow[]>;
  claimShopifySourceSync(shopId: string, shopDomain: string, at: Date): Promise<ShopifyBrandSyncClaim | null>;
  completeShopifySourceSync(claim: ShopifyBrandSyncClaim, snapshot: ShopifyBrandSnapshot,
    at: Date): Promise<{ applied: boolean; changedRoles: number }>;
  failShopifySourceSync(claim: ShopifyBrandSyncClaim, code: ShopifyBrandFailureCode,
    retryable: boolean, retryAfterMs: number | null, at: Date): Promise<boolean>;
}

export type ShopifyGrant = "GRANTED" | "MISSING_READ_BRAND_SCOPE" | "NO_OFFLINE_SESSION";

export interface ShopifyBrandSyncDependencies {
  repository: ShopifyBrandSyncRepository;
  reader: ShopifyBrandReader;
  grantForShop: (domain: string) => Promise<ShopifyGrant>;
  logger: Pick<StructuredLogger, "info" | "warn" | "error">;
  now?: () => Date;
  pageSize?: number;
  maxShopsPerTick?: number;
  maxSyncsPerTick?: number;
  concurrency?: number;
}

function safeShopId(shopId: string): string {
  return /^[A-Za-z0-9_-]{1,128}$/.test(shopId) ? shopId : "INVALID_SHOP_ID";
}

/** Scan shops, not assets: first-connect sync occurs even when ShopBrand has no row. */
export class ShopifyBrandSourceSyncService {
  private cursor: string | null = null;
  private readonly now: () => Date;
  private readonly pageSize: number;
  private readonly maxShops: number;
  private readonly maxSyncs: number;
  private readonly concurrency: number;

  constructor(private readonly deps: ShopifyBrandSyncDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.pageSize = deps.pageSize ?? 50;
    this.maxShops = deps.maxShopsPerTick ?? 500;
    this.maxSyncs = deps.maxSyncsPerTick ?? 20;
    this.concurrency = deps.concurrency ?? 2;
    if (![this.pageSize, this.maxShops, this.maxSyncs, this.concurrency].every((v) =>
          Number.isSafeInteger(v) && v > 0) ||
        this.pageSize > 100 || this.maxShops > 2_000 ||
        this.maxSyncs > 100 || this.concurrency > 4) {
      throw new RangeError("INVALID_SHOPIFY_BRAND_SCHEDULER_BOUNDS");
    }
  }

  async reconcileOnce(): Promise<{ inspected: number; claimed: number; failed: number }> {
    let inspected = 0;
    const claims: ShopifyBrandSyncClaim[] = [];
    let endReached = false;
    const failures: unknown[] = [];
    while (inspected < this.maxShops && claims.length < this.maxSyncs && !endReached) {
      const take = Math.min(this.pageSize, this.maxShops - inspected);
      let page: ShopifyShopScanRow[];
      try {
        page = await this.deps.repository.listShopifyShopsPage(this.cursor, take);
      } catch (error) {
        this.deps.logger.error("shop_brand.shopify.page_failed", {
          reasonCode: "SHOP_SCAN_FAILED", exceptionType: error instanceof Error ? "Error" : "NonErrorThrownValue",
        });
        throw error;
      }
      if (!page.length) { this.cursor = null; break; }
      let processedFromPage = 0;
      for (const shop of page) {
        processedFromPage++;
        inspected++;
        this.cursor = shop.id;
        try {
          const doc = parseBrandDocument(shop.brand?.whatsAppMedia ?? {});
          const due = doc.shopifySourceSync?.nextDueAt;
          const leased = doc.shopifySourceSync?.leaseUntil;
          const now = this.now();
          if ((!due || Date.parse(due) <= now.getTime()) &&
              (!leased || Date.parse(leased) <= now.getTime())) {
            const claim = await this.deps.repository.claimShopifySourceSync(shop.id, shop.domain, now);
            if (claim) claims.push(claim);
          }
        } catch (error) {
          this.deps.logger.error("shop_brand.shopify.shop_claim_failed", {
            shopId: safeShopId(shop.id), reasonCode: "CLAIM_FAILED",
            exceptionType: error instanceof Error ? "Error" : "NonErrorThrownValue",
          });
          failures.push(error);
        }
        if (claims.length >= this.maxSyncs) break;
      }
      if (page.length < take && processedFromPage === page.length) {
        this.cursor = null;
        endReached = true;
      }
    }
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(claims.length, this.concurrency) }, async () => {
      while (next < claims.length) {
        const claim = claims[next++]!;
        try { await this.process(claim); }
        catch (error) {
          this.deps.logger.error("shop_brand.shopify.sync_failed", {
            shopId: safeShopId(claim.shopId), reasonCode: "SYNC_PERSISTENCE_FAILED",
            exceptionType: error instanceof Error ? "Error" : "NonErrorThrownValue",
          });
          failures.push(error);
        }
      }
    }));
    this.deps.logger.info("shop_brand.shopify.sync_cycle", {
      inspected, claimed: claims.length, failed: failures.length,
    });
    if (failures.length) throw new AggregateError(failures, "SHOPIFY_BRAND_SYNC_CYCLE_FAILED");
    return { inspected, claimed: claims.length, failed: 0 };
  }

  private async process(claim: ShopifyBrandSyncClaim): Promise<void> {
    let snapshot: ShopifyBrandSnapshot;
    try {
      const grant = await this.deps.grantForShop(claim.shopDomain);
      if (grant !== "GRANTED") throw new ShopifyBrandSyncError(grant, false);
      snapshot = await this.deps.reader.read(claim.shopDomain, this.now());
    } catch (error) {
      const failure = error instanceof ShopifyBrandSyncError
        ? error : new ShopifyBrandSyncError("SHOPIFY_UNAVAILABLE", true);
      this.deps.logger.error("shop_brand.shopify.provider_failed", {
        shopId: safeShopId(claim.shopId), reasonCode: failure.code,
        retryable: failure.retryable,
        exceptionType: error instanceof ShopifyBrandSyncError ? "ShopifyBrandSyncError" :
          error instanceof Error ? "Error" : "NonErrorThrownValue",
      });
      // Failure bookkeeping is durable. If it fails, propagate to scheduler for visibility.
      const recorded = await this.deps.repository.failShopifySourceSync(
        claim, failure.code, failure.retryable, failure.retryAfterMs, this.now(),
      );
      if (!recorded) {
        this.deps.logger.warn("shop_brand.shopify.failure_record_stale", {
          shopId: safeShopId(claim.shopId), reasonCode: failure.code,
        });
      }
      return;
    }
    // Persistence failures are NOT provider failures; log/propagate them without resetting the
    // source lease. An expired lease is safely reclaimed on a later scheduler tick.
    const result = await this.deps.repository.completeShopifySourceSync(claim, snapshot, this.now());
    this.deps.logger.info(result.applied ? "shop_brand.shopify.sources_observed" :
      "shop_brand.shopify.stale_result", {
      shopId: safeShopId(claim.shopId), changedRoles: result.changedRoles,
    });
  }
}
