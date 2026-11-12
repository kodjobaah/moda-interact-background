import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { parseBrandDocument, updateObservedSource } from "../shop-brand-media-orchestration/state.js";
import type { BrandDocument } from "../shop-brand-media-orchestration/contracts.js";
import { shopifyBrandObservations } from "./mapping.js";
import { SHOPIFY_BRAND_SYNC_INTERVAL_MS, SHOPIFY_BRAND_SYNC_LEASE_MS, SHOPIFY_BRAND_SYNC_RETRY_MS,
  type ShopifyBrandSyncClaim, type ShopifyBrandSnapshot, type ShopifyBrandFailureCode } from "./contracts.js";

type Database = Pick<PrismaClient, "$transaction" | "shop">;
export type AssetShop = { id: string; domain: string; installedAt: Date };
type Sync = { lastSuccessfulAt: string | null; nextDueAt: string | null; lastAttemptAt: string | null;
  attempts: number; failureCode: string | null; leaseOwner: string | null; leaseUntil: string | null };
const empty = (): Sync => ({ lastSuccessfulAt: null, nextDueAt: null, lastAttemptAt: null,
  attempts: 0, failureCode: null, leaseOwner: null, leaseUntil: null });
function stateOf(document: BrandDocument): Sync {
  const raw = (document as BrandDocument & { shopifySourceSync?: unknown }).shopifySourceSync;
  if (raw === undefined) return empty();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_ASSET_SYNC_STATE");
  const state = raw as Sync;
  if (!Number.isSafeInteger(state.attempts) || state.attempts < 0 || state.attempts > 5 ||
      ![state.lastSuccessfulAt, state.nextDueAt, state.lastAttemptAt, state.leaseUntil].every(value => value === null ||
        (typeof value === "string" && Number.isFinite(Date.parse(value)))) ||
      !(state.leaseOwner === null || (typeof state.leaseOwner === "string" && /^[a-f0-9-]{36}$/.test(state.leaseOwner))) ||
      !(state.failureCode === null || (typeof state.failureCode === "string" && /^[A-Z_]{1,64}$/.test(state.failureCode)))) {
    throw new Error("INVALID_ASSET_SYNC_STATE");
  }
  return state;
}
export type AssetClaimResult = { kind: "claimed"; claim: ShopifyBrandSyncClaim } |
  { kind: "not_due" };

/** Provider access is outside transactions. Shop/installation identity and all metadata commit under row locks. */
export class ShopifyBrandSourceRepository {
  constructor(private readonly db: Database) {}
  list(after: string | null, limit: number): Promise<AssetShop[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("INVALID_ASSET_SCAN_LIMIT");
    return this.db.shop.findMany({ where: { platform: "SHOPIFY", status: "ACTIVE", uninstalledAt: null,
      reinstallPendingAt: null, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: "asc" }, take: limit,
      select: { id: true, domain: true, installedAt: true } });
  }
  async claim(shop: AssetShop, now: Date): Promise<AssetClaimResult> {
    return (await this.edit(shop.id, shop.domain, shop.installedAt.toISOString(), now, (document, state) => {
      if (state.leaseUntil && Date.parse(state.leaseUntil) > now.getTime()) return null;
      if (state.nextDueAt && Date.parse(state.nextDueAt) > now.getTime()) return null;
      const leaseOwner = randomUUID(); const leaseUntil = new Date(now.getTime() + SHOPIFY_BRAND_SYNC_LEASE_MS).toISOString();
      return { document, state: { ...state, leaseOwner, leaseUntil, lastAttemptAt: now.toISOString() }, value: {
        kind: "claimed", claim: { shopId: shop.id, shopDomain: shop.domain, installedAt: shop.installedAt.toISOString(),
          leaseOwner, leaseUntil } } as AssetClaimResult };
    })) ?? { kind: "not_due" };
  }
  async complete(claim: ShopifyBrandSyncClaim, snapshot: ShopifyBrandSnapshot, now: Date): Promise<boolean> {
    const observed = new Date(snapshot.observedAt);
    if (!Number.isFinite(observed.getTime()) || observed.getTime() > now.getTime() + 60_000) throw new Error("INVALID_ASSET_OBSERVATION");
    return (await this.edit(claim.shopId, claim.shopDomain, claim.installedAt, now, (current, state) => {
      if (!this.matches(state, claim, now)) return null;
      let document = current;
      const observations = shopifyBrandObservations(claim.shopId, snapshot);
      const newerLogo = current.roles.LOGO?.source;
      if (!snapshot.squareLogo && newerLogo && Date.parse(newerLogo.observedAt) > observed.getTime()) {
        observations[1] = { ...observations[1]!, sourceUrl: newerLogo.url,
          sourceReference: newerLogo.url ? `fallback:${newerLogo.reference ?? ""}` : null,
          observedAt: newerLogo.observedAt };
      }
      const fields: Prisma.ShopBrandUpdateInput = { fetchedAt: now };
      for (const observation of observations) {
        const previous = document.roles[observation.role]?.source;
        if (previous && Date.parse(previous.observedAt) >= Date.parse(observation.observedAt)) continue;
        const result = updateObservedSource(document, observation); document = result.document;
        if (observation.role === "LOGO") {
          fields.logoUrl = snapshot.logo?.url ?? null; fields.logoWidth = snapshot.logo?.width ?? null;
          fields.logoHeight = snapshot.logo?.height ?? null;
          if (result.changed) fields.logoAltText = null;
        } else if (observation.role === "SQUARE_LOGO") {
          fields.squareLogoUrl = snapshot.squareLogo?.url ?? null;
          if (result.changed) fields.squareLogoAltText = null;
        } else fields.coverImageUrl = snapshot.coverImage?.url ?? null;
      }
      return { document, fields, state: { ...state, lastSuccessfulAt: now.toISOString(),
        nextDueAt: new Date(now.getTime() + SHOPIFY_BRAND_SYNC_INTERVAL_MS).toISOString(), attempts: 0,
        failureCode: null, leaseOwner: null, leaseUntil: null }, value: true };
    })) ?? false;
  }
  async fail(claim: ShopifyBrandSyncClaim, code: ShopifyBrandFailureCode, retryable: boolean,
    retryAfter: number | null, now: Date): Promise<boolean> {
    return (await this.edit(claim.shopId, claim.shopDomain, claim.installedAt, now, (document, state) => {
      if (!this.matches(state, claim, now)) return null;
      const attempts = Math.min(5, state.attempts + 1);
      const delay = retryable ? Math.max(SHOPIFY_BRAND_SYNC_RETRY_MS[attempts - 1]!, retryAfter ?? 0) : SHOPIFY_BRAND_SYNC_INTERVAL_MS;
      return { document, state: { ...state, attempts, failureCode: code, leaseOwner: null, leaseUntil: null,
        nextDueAt: new Date(now.getTime() + Math.min(SHOPIFY_BRAND_SYNC_INTERVAL_MS, delay)).toISOString() }, value: true };
    })) ?? false;
  }
  private matches(state: Sync, claim: ShopifyBrandSyncClaim, now: Date): boolean {
    return state.leaseOwner === claim.leaseOwner && state.leaseUntil === claim.leaseUntil && Date.parse(claim.leaseUntil) > now.getTime();
  }
  private async edit<T>(shopId: string, domain: string, installedAt: string, now: Date,
    update: (document: BrandDocument, state: Sync) =>
      { document: BrandDocument; state: Sync; fields?: Prisma.ShopBrandUpdateInput; value: T } | null): Promise<T | null> {
    if (!Number.isFinite(now.getTime())) throw new Error("INVALID_ASSET_CLOCK");
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.$transaction(async tx => {
          const rows = await tx.$queryRaw<Array<{ domain: string; platform: string; status: string; installedAt: Date;
            uninstalledAt: Date | null; reinstallPendingAt: Date | null }>>(Prisma.sql`
            SELECT "domain", "platform"::text, "status"::text, "installedAt", "uninstalledAt", "reinstallPendingAt"
            FROM "commerce"."Shop" WHERE "id"=${shopId} FOR UPDATE`);
          const shop = rows[0];
          if (!shop || shop.domain !== domain || shop.platform !== "SHOPIFY" || shop.status !== "ACTIVE" ||
              shop.uninstalledAt || shop.reinstallPendingAt || shop.installedAt.toISOString() !== installedAt) return null;
          await tx.shopBrand.upsert({ where: { shopId }, create: { shopId }, update: {} });
          const brands = await tx.$queryRaw<Array<{ whatsAppMedia: Prisma.JsonValue }>>(Prisma.sql`
            SELECT "whatsAppMedia" FROM "commerce"."ShopBrand" WHERE "shopId"=${shopId} FOR UPDATE`);
          const document = parseBrandDocument(brands[0]!.whatsAppMedia);
          const result = update(document, stateOf(document));
          if (!result) return null;
          await tx.shopBrand.update({ where: { shopId }, data: { ...result.fields,
            whatsAppMedia: { ...result.document, shopifySourceSync: result.state } as unknown as Prisma.InputJsonValue } });
          return result.value;
        }, { timeout: 10_000, maxWait: 5_000 });
      } catch (error) {
        if (attempt < 2 && error && typeof error === "object" && "code" in error && (error.code === "P2034" || error.code === "P2002")) continue;
        throw error;
      }
    }
  }
}
