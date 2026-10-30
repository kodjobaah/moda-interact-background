import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type {
  BrandClaim, BrandDocument, BrandOutcome, BrandRole, SourceObservation, ShopifySourceSync,
} from "./contracts.js";
import { BrandStateError } from "./contracts.js";
import { claimRole, completeClaim, failClaim, parseBrandDocument, updateObservedSource } from "./state.js";
import {
  SHOPIFY_BRAND_SYNC_INTERVAL_MS, SHOPIFY_BRAND_SYNC_LEASE_MS, SHOPIFY_BRAND_SYNC_RETRY_MS,
  type ShopifyBrandSnapshot, type ShopifyBrandSyncClaim, type ShopifyBrandFailureCode,
} from "../shop-brand-media-shopify/contracts.js";
import { shopifyBrandObservations } from "../shop-brand-media-shopify/mapping.js";

export type ScannedBrandRow = { shopId: string; whatsAppMedia: unknown };
export type ShopifyShopScanRow = { id: string; domain: string; brand: { whatsAppMedia: unknown } | null };
export type ShopBrandMediaDatabase = Pick<PrismaClient, "$transaction" | "shopBrand" | "shop">;

const emptyShopifySync = (): ShopifySourceSync => ({
  lastSuccessfulAt: null, nextDueAt: null, lastAttemptAt: null,
  attempts: 0, failureCode: null, leaseOwner: null, leaseUntil: null,
});

function hasValidLease(doc: BrandDocument, claim: ShopifyBrandSyncClaim, at: Date): boolean {
  const state = doc.shopifySourceSync;
  return !!state && state.leaseOwner === claim.leaseOwner &&
    state.leaseUntil === claim.leaseUntil && Date.parse(claim.leaseUntil) > at.getTime();
}

type ShopifyBrandColumns = {
  brandName: string;
  logoUrl: string | null;
  logoAltText: string | null;
  logoWidth: number | null;
  logoHeight: number | null;
  squareLogoUrl: string | null;
  squareLogoAltText: string | null;
  coverImageUrl: string | null;
  fetchedAt: Date;
};

/**
 * Atomic ShopBrand JSONB role updates. The only transaction spans one row-lock and one JSON write.
 * No fetch, image processing, R2 call, Redis publication or other external I/O is allowed in it.
 */
export class ShopBrandMediaRepository {
  constructor(
    private readonly database: ShopBrandMediaDatabase,
    private readonly logger: Pick<StructuredLogger, "warn" | "error">,
  ) {}

  async observeSource(observation: SourceObservation): Promise<{ changed: boolean; generation: number }> {
    return this.editLocked(observation.shopId, true, (current) => {
      const outcome = updateObservedSource(current, observation);
      return { document: outcome.document, value: {
        changed: outcome.changed, generation: outcome.document.roles[observation.role]!.source.generation,
      } };
    }).then((value) => {
      if (!value) throw new Error("SHOP_BRAND_SOURCE_ROW_MISSING");
      return value;
    });
  }

  /** Bounded keyset scan over eligible connected Shopify shops; no joined media rows lock. */
  async listShopifyShopsPage(afterShopId: string | null, limit: number): Promise<ShopifyShopScanRow[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("INVALID_SHOPIFY_BRAND_SCAN_LIMIT");
    }
    return this.database.shop.findMany({
      where: { platform: "SHOPIFY", status: "ACTIVE",
        ...(afterShopId ? { id: { gt: afterShopId } } : {}) },
      orderBy: { id: "asc" }, take: limit,
      select: { id: true, domain: true, brand: { select: { whatsAppMedia: true } } },
    });
  }

  /** Durable per-shop lease prevents duplicate concurrent Shopify provider reads. */
  async claimShopifySourceSync(shopId: string, shopDomain: string, at: Date): Promise<ShopifyBrandSyncClaim | null> {
    if (!Number.isFinite(at.getTime()) || !/^[A-Za-z0-9_-]{1,128}$/.test(shopId)) {
      throw new Error("INVALID_SHOPIFY_SYNC_IDENTITY");
    }
    const leaseOwner = randomUUID();
    return this.editLocked(shopId, true, (document) => {
      const sync = document.shopifySourceSync ?? emptyShopifySync();
      const now = at.getTime();
      if ((sync.leaseUntil && Date.parse(sync.leaseUntil) > now) ||
          (sync.nextDueAt && Date.parse(sync.nextDueAt) > now)) {
        return { document, value: null };
      }
      const leaseUntil = new Date(now + SHOPIFY_BRAND_SYNC_LEASE_MS).toISOString();
      return { document: { ...document, shopifySourceSync: {
        ...sync, leaseOwner, leaseUntil, lastAttemptAt: at.toISOString(),
      } }, value: { shopId, shopDomain, leaseOwner, leaseUntil } };
    }, true, shopDomain);
  }

  /** Commit original columns and all role source observations under the *same* BG002 row lock. */
  async completeShopifySourceSync(claim: ShopifyBrandSyncClaim, snapshot: ShopifyBrandSnapshot,
    at: Date): Promise<{ applied: boolean; changedRoles: number }> {
    const applied = await this.editLocked(claim.shopId, false, (current) => {
      if (!hasValidLease(current, claim, at)) {
        return { document: current, value: { applied: false, changedRoles: 0 } };
      }
      // Compare producer observations using the existing BG002 generation/ordering algorithm.
      // Never regress a newer persisted source or its legacy column on a delayed observation.
      let document = current;
      let changedRoles = 0;
      const observed = new Date(snapshot.observedAt);
      if (!Number.isFinite(observed.getTime()) || observed.getTime() > at.getTime() + 60_000) {
        throw new Error("INVALID_SHOPIFY_SYNC_OBSERVATION");
      }
      const fields: Partial<ShopifyBrandColumns> = {};
      const observations = shopifyBrandObservations(claim.shopId, snapshot);
      const latestLogo = current.roles.LOGO?.source;
      // When another trusted observation overtakes this network response, a square
      // fallback must track that newer logo rather than reintroduce the old one.
      if (snapshot.squareLogo === null && latestLogo &&
          Date.parse(latestLogo.observedAt) > observed.getTime()) {
        observations[1] = {
          ...observations[1]!, sourceUrl: latestLogo.url,
          sourceReference: latestLogo.url ? `fallback:${latestLogo.reference ?? ""}` : null,
          observedAt: latestLogo.observedAt,
        };
      }
      for (const observation of observations) {
        const previousAt = document.roles[observation.role]?.source.observedAt;
        if (previousAt && Date.parse(previousAt) >= observed.getTime()) continue;
        const result = updateObservedSource(document, observation);
        document = result.document;
        if (result.changed) changedRoles++;
        if (observation.role === "LOGO") {
          fields.logoUrl = snapshot.logo?.url ?? null;
          if (result.changed) fields.logoAltText = null; // No provider alt text; preserve on unchanged source.
          fields.logoWidth = snapshot.logo?.width ?? null;
          fields.logoHeight = snapshot.logo?.height ?? null;
        } else if (observation.role === "SQUARE_LOGO") {
          fields.squareLogoUrl = snapshot.squareLogo?.url ?? null; // Null when derived from logo.
          if (result.changed) fields.squareLogoAltText = null;
        } else {
          fields.coverImageUrl = snapshot.coverImage?.url ?? null;
        }
      }
      if (!current.shopifySourceSync?.lastSuccessfulAt ||
          Date.parse(current.shopifySourceSync.lastSuccessfulAt) < observed.getTime()) {
        fields.brandName = snapshot.brandName;
      }
      fields.fetchedAt = at;
      const sync: ShopifySourceSync = {
        lastSuccessfulAt: at.toISOString(),
        nextDueAt: new Date(at.getTime() + SHOPIFY_BRAND_SYNC_INTERVAL_MS).toISOString(),
        lastAttemptAt: current.shopifySourceSync!.lastAttemptAt,
        attempts: 0, failureCode: null, leaseOwner: null, leaseUntil: null,
      };
      return { document: { ...document, shopifySourceSync: sync }, fields,
        value: { applied: true, changedRoles } };
    }, true);
    return applied ?? { applied: false, changedRoles: 0 };
  }

  /** A failed provider read updates only cadence/error metadata, NEVER brand source fields. */
  async failShopifySourceSync(claim: ShopifyBrandSyncClaim, code: ShopifyBrandFailureCode,
    retryable: boolean, retryAfterMs: number | null, at: Date): Promise<boolean> {
    const applied = await this.editLocked(claim.shopId, false, (document) => {
      if (!hasValidLease(document, claim, at)) return { document, value: false };
      const previous = document.shopifySourceSync!;
      const attempts = Math.min(5, previous.attempts + 1);
      const minDelay = retryable ? SHOPIFY_BRAND_SYNC_RETRY_MS[attempts - 1]! : SHOPIFY_BRAND_SYNC_INTERVAL_MS;
      const delay = Math.min(SHOPIFY_BRAND_SYNC_INTERVAL_MS, Math.max(minDelay,
        retryable ? retryAfterMs ?? 0 : 0));
      const next: ShopifySourceSync = { ...previous, attempts, failureCode: code,
        nextDueAt: new Date(at.getTime() + delay).toISOString(), leaseOwner: null, leaseUntil: null };
      return { document: { ...document, shopifySourceSync: next }, value: true };
    });
    return applied ?? false;
  }

  async claim(shopId: string, role: BrandRole, at: Date = new Date()): Promise<BrandClaim | null> {
    const owner = randomUUID();
    return this.editLocked(shopId, false, (current, currentDomain) => {
      const { document, claim } = claimRole(current, shopId, currentDomain, role, owner, at);
      return { document, value: claim };
    });
  }

  async complete(claim: BrandClaim, result: BrandOutcome, at: Date = new Date()): Promise<boolean> {
    const outcome = await this.editLocked(claim.shopId, false, (current, currentDomain) => {
      const { document, applied } = completeClaim(current, claim, result, at, currentDomain);
      return { document, value: applied };
    });
    return outcome ?? false;
  }

  async fail(claim: BrandClaim, failureCode: string, retryable: boolean, at: Date = new Date()): Promise<boolean> {
    const outcome = await this.editLocked(claim.shopId, false, (current, currentDomain) => {
      const { document, applied } = failClaim(current, claim, failureCode, retryable, at, currentDomain);
      return { document, value: applied };
    });
    return outcome ?? false;
  }

  /** Keyset traversal over the existing unique shopId index; no full-table lock or OFFSET scan. */
  async listPage(afterShopId: string | null, limit: number): Promise<ScannedBrandRow[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("INVALID_MEDIA_SCAN_LIMIT");
    const rows = await this.database.shopBrand.findMany({
      where: afterShopId ? { shopId: { gt: afterShopId } } : {},
      orderBy: { shopId: "asc" }, take: limit,
      select: { shopId: true, whatsAppMedia: true, shop: { select: { domain: true } } },
    });
    return rows.map(({ shopId, whatsAppMedia, shop }) => ({ shopId, domain: shop.domain, whatsAppMedia }));
  }

  private async editLocked<T>(
    shopId: string, create: boolean,
    edit: (current: BrandDocument) => { document: BrandDocument; value: T; fields?: Partial<ShopifyBrandColumns> },
    requireActiveShopify = false,
    expectedShopDomain?: string,
  ): Promise<T | null> {
    // A competing first observation may race INSERT. Retry aborted SERIALIZABLE/deadlock/unique
    // transactions, never swallowing other DB errors or synthesising a row for a missing shop.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.database.$transaction(async (tx) => {
          if (requireActiveShopify) {
            const shop = await tx.shop.findUnique({
              where: { id: shopId }, select: { platform: true, status: true, domain: true },
            });
            if (!shop || shop.platform !== "SHOPIFY" || shop.status !== "ACTIVE" ||
                (expectedShopDomain && shop.domain !== expectedShopDomain)) return null;
          }
          if (create) {
            await tx.shopBrand.upsert({ where: { shopId }, create: { shopId }, update: {} });
          }
          const locked = await tx.$queryRaw<Array<{ whatsAppMedia: Prisma.JsonValue; domain: string }>>(Prisma.sql`
            SELECT brand."whatsAppMedia", shop."domain"
            FROM "commerce"."ShopBrand" AS brand
            JOIN "commerce"."Shop" AS shop ON shop."id" = brand."shopId"
            WHERE brand."shopId" = ${shopId}
            FOR UPDATE OF brand, shop
          `);
          const row = locked[0];
          if (!row) return null;
          const current = parseBrandDocument(row.whatsAppMedia);
          const outcome = edit(current);
          if (outcome.document !== current || outcome.fields) {
            await tx.shopBrand.update({ where: { shopId },
              data: { ...outcome.fields,
                whatsAppMedia: outcome.document as unknown as Prisma.InputJsonValue } });
          }
          return outcome.value;
        }, { timeout: 10_000, maxWait: 5_000 });
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? error.code : undefined;
        const retryable = code === "P2002" || code === "P2034";
        // Preserve the original Prisma failure message for development diagnosis.
        const fields = {
          shopId: /^[A-Za-z0-9_-]{1,128}$/.test(shopId) ? shopId : "INVALID_SHOP_ID",
          operation: requireActiveShopify ? "shopify_sync" : create ? "observe_source" : "update_role",
          attempt, reasonCode: error instanceof BrandStateError ? error.code :
            retryable ? code : "PERSISTENCE_FAILURE",
          exceptionType: error instanceof BrandStateError ? "BrandStateError" :
            error instanceof Error ? "Error" : "NonErrorThrownValue",
          errorMessage: error instanceof Error ? error.message : String(error),
          error,
        };
        if (retryable && attempt < 3) {
          this.logger.warn("shop_brand.media.transaction_retry", fields);
          continue;
        }
        this.logger.error("shop_brand.media.transaction_failed", fields);
        throw error;
      }
    }
    throw new Error("SHOP_BRAND_TRANSACTION_RETRIES_EXHAUSTED");
  }
}
