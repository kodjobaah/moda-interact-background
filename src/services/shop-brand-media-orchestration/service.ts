import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { ShopBrandMediaError, type ShopBrandMediaProcessor } from "../shop-brand-media/contracts.js";
import { BRAND_ROLES, BrandStateError, type BrandClaim, type BrandRole } from "./contracts.js";
import { claimable, parseBrandDocument } from "./state.js";
import type { ScannedBrandRow } from "./repository.js";

export interface BrandMediaPersistence {
  listPage(afterShopId: string | null, limit: number): Promise<ScannedBrandRow[]>;
  claim(shopId: string, role: BrandRole, at?: Date): Promise<BrandClaim | null>;
  complete(claim: BrandClaim, outcome: { result: Awaited<ReturnType<ShopBrandMediaProcessor["process"]>>; verifiedAt: string }, at?: Date): Promise<boolean>;
  fail(claim: BrandClaim, failureCode: string, retryable: boolean, at?: Date): Promise<boolean>;
}

export type BrandMediaServiceOptions = {
  repository: BrandMediaPersistence;
  processor: ShopBrandMediaProcessor;
  logger: Pick<StructuredLogger, "info" | "warn" | "error">;
  now?: () => Date;
  pageSize?: number;
  maxRowsPerSweep?: number;
  maxClaimsPerSweep?: number;
  concurrency?: number;
};

/**
 * A sweep is bounded on *both* row reads and media network work; cursor advances after every
 * inspected shop, including permanently failed shops, to avoid hot-tenant starvation.
 * Claims serialize per ShopBrand row across all replicas; any lost best-effort wake is harmless.
 */
export class ShopBrandMediaReconciliationService {
  private cursor: string | null = null;
  private readonly now: () => Date;
  private readonly pageSize: number;
  private readonly maxRows: number;
  private readonly maxClaims: number;
  private readonly concurrency: number;

  constructor(private readonly deps: BrandMediaServiceOptions) {
    this.now = deps.now ?? (() => new Date());
    this.pageSize = deps.pageSize ?? 50;
    this.maxRows = deps.maxRowsPerSweep ?? 500;
    this.maxClaims = deps.maxClaimsPerSweep ?? 20;
    this.concurrency = deps.concurrency ?? 2;
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 100 ||
        !Number.isSafeInteger(this.maxRows) || this.maxRows < 1 || this.maxRows > 2_000 ||
        !Number.isSafeInteger(this.maxClaims) || this.maxClaims < 1 || this.maxClaims > 100 ||
        !Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 4) {
      throw new RangeError("INVALID_BRAND_RECONCILIATION_BOUNDS");
    }
  }

  async reconcileOnce(): Promise<{ inspected: number; claimed: number; cursor: string | null }> {
    const begun = this.now().getTime();
    const claims: BrandClaim[] = [];
    let inspected = 0;
    let endReached = false;
    while (inspected < this.maxRows && claims.length < this.maxClaims && !endReached) {
      const take = Math.min(this.pageSize, this.maxRows - inspected);
      let page: ScannedBrandRow[];
      try {
        page = await this.deps.repository.listPage(this.cursor, take);
      } catch (error) {
        this.deps.logger.error("shop_brand.media.scan_page_failed", {
          reasonCode: "PAGE_READ_FAILURE",
          exceptionType: error instanceof Error ? "Error" : "NonErrorThrownValue",
          pageSize: take,
        });
        throw error;
      }
      if (page.length === 0) { this.cursor = null; break; }
      let processedFromPage = 0;
      for (const row of page) {
        processedFromPage++;
        inspected++;
        this.cursor = row.shopId;
        try {
          const document = parseBrandDocument(row.whatsAppMedia);
          // One role per shop per sweep to avoid a single shop dominating external I/O.
          const selected = BRAND_ROLES.find((role) => claimable(document.roles[role], this.now().getTime()));
          if (selected) {
            const claim = await this.deps.repository.claim(row.shopId, selected, this.now());
            if (claim) claims.push(claim);
          }
        } catch (error) {
          this.deps.logger.error("shop_brand.media.scan_row_failed", {
            shopId: /^[A-Za-z0-9_-]{1,128}$/.test(row.shopId) ? row.shopId : "INVALID_SHOP_ID",
            reasonCode: error instanceof BrandStateError ? error.code : "SCAN_ROW_FAILURE",
            exceptionType: error instanceof BrandStateError ? "BrandStateError" :
              error instanceof Error ? "Error" : "NonErrorThrownValue",
          });
        }
        if (claims.length >= this.maxClaims) break;
      }
      if (page.length < take && processedFromPage === page.length) {
        this.cursor = null;
        endReached = true;
      }
    }
    // Bound in-flight fetch/transform/R2 calls. Complete or fail each claim independently.
    const failures: unknown[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(claims.length, this.concurrency) }, async () => {
      while (next < claims.length) {
        const claim = claims[next++]!;
        try { await this.processClaim(claim); }
        catch (error) {
          // A failed DB completion must not hide the failure of an individual claim
          // behind the aggregate cycle error. Continue other claims, then reject.
          this.deps.logger.error("shop_brand.media.claim_failed", {
            shopId: claim.shopId, role: claim.role, generation: claim.generation,
            kind: claim.kind,
            reasonCode: error instanceof BrandStateError ? error.code : "CLAIM_OPERATION_FAILED",
            exceptionType: error instanceof BrandStateError ? "BrandStateError" :
              error instanceof Error ? "Error" : "NonErrorThrownValue",
          });
          failures.push(error);
        }
      }
    }));
    this.deps.logger.info("shop_brand.media.reconcile_cycle", {
      inspected, claimed: claims.length, failed: failures.length, durationMs: this.now().getTime() - begun,
    });
    if (failures.length) throw new AggregateError(failures, "SHOP_BRAND_RECONCILIATION_FAILURE");
    return { inspected, claimed: claims.length, cursor: this.cursor };
  }

  /** Optional post-commit local wake; the five-minute scanner remains the correctness path. */
  async reconcileShop(shopId: string): Promise<void> {
    for (const role of BRAND_ROLES) {
      try {
        const claim = await this.deps.repository.claim(shopId, role, this.now());
        if (claim) await this.processClaim(claim);
      } catch (error) {
        this.deps.logger.error("shop_brand.media.local_wake_failed", {
          shopId: /^[A-Za-z0-9_-]{1,128}$/.test(shopId) ? shopId : "INVALID_SHOP_ID",
          role,
          reasonCode: error instanceof BrandStateError ? error.code : "LOCAL_WAKE_FAILURE",
          exceptionType: error instanceof BrandStateError ? "BrandStateError" :
            error instanceof Error ? "Error" : "NonErrorThrownValue",
        });
        throw error;
      }
    }
  }

  private async processClaim(claim: BrandClaim): Promise<void> {
    const startedAt = this.now().getTime();
    let result: Awaited<ReturnType<ShopBrandMediaProcessor["process"]>>;
    try {
      result = await this.deps.processor.process({
        shopId: claim.shopId, role: claim.role, sourceUrl: claim.sourceUrl,
        sourceFingerprint: claim.fingerprint, sourceGeneration: claim.generation,
      });
    } catch (error) {
      const reason = error instanceof ShopBrandMediaError ? error.code : "UNEXPECTED_FAILURE";
      const retryable = error instanceof ShopBrandMediaError ? error.retryable : true;
      this.deps.logger.error("shop_brand.media.processing_failed", {
        shopId: claim.shopId, role: claim.role, generation: claim.generation,
        kind: claim.kind, reasonCode: reason, retryable,
        exceptionType: error instanceof ShopBrandMediaError ? "ShopBrandMediaError" :
          error instanceof Error ? "Error" : "NonErrorThrownValue",
        durationMs: this.now().getTime() - startedAt,
      });
      // If the DB update fails, surface it to the scheduler. The expired lease will be
      // reclaimed without claiming a false success or swallowing the persistence failure.
      const applied = await this.deps.repository.fail(claim, reason, retryable, this.now());
      if (!applied) {
        this.deps.logger.warn("shop_brand.media.failure_record_stale", {
          shopId: claim.shopId, role: claim.role,
          generation: claim.generation, kind: claim.kind, reasonCode: reason,
        });
      }
      return;
    }
    const at = this.now();
    const applied = await this.deps.repository.complete(claim, { result, verifiedAt: at.toISOString() }, at);
    this.deps.logger.info(applied ? "shop_brand.media.ready" : "shop_brand.media.stale_result", {
      shopId: claim.shopId, role: claim.role, generation: claim.generation,
      kind: claim.kind, durationMs: at.getTime() - startedAt,
      ...(applied ? { contentSha256: result.contentSha256, sizeBytes: result.sizeBytes,
        contentType: result.contentType } : {}),
    });
  }
}
