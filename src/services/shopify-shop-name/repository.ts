import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { parseBrandDocument } from "../shop-brand-media-orchestration/state.js";
import { NAME_LEASE_MS, NAME_REFRESH_MS, NAME_RETRY_MS, type NameClaim, type NameSync } from "./contracts.js";

type Database = Pick<PrismaClient, "$transaction" | "shop">;
export type NameShop = { id: string; domain: string; installedAt: Date };
const empty = (): NameSync => ({ lastSuccessfulAt: null, nextDueAt: null, attempts: 0,
  failureCode: null, leaseOwner: null, leaseUntil: null });
function syncState(raw: unknown): NameSync {
  if (raw === undefined) return empty();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_NAME_SYNC_STATE");
  const s = raw as NameSync;
  if (!Number.isSafeInteger(s.attempts) || s.attempts < 0 || s.attempts > 5 ||
      ![s.lastSuccessfulAt, s.nextDueAt, s.leaseUntil].every(v => v === null || (typeof v === "string" && Number.isFinite(Date.parse(v)))) ||
      !(s.leaseOwner === null || (typeof s.leaseOwner === "string" && /^[a-z0-9-]{36}$/.test(s.leaseOwner))) ||
      !(s.failureCode === null || (typeof s.failureCode === "string" && /^[A-Z_]{1,64}$/.test(s.failureCode)))) {
    throw new Error("INVALID_NAME_SYNC_STATE");
  }
  return s;
}

/** Durable per-Shop lease; external credential/provider work is always outside these transactions. */
export class ShopNameRepository {
  constructor(private readonly db: Database) {}
  list(after: string | null, limit: number): Promise<NameShop[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("INVALID_NAME_SCAN_LIMIT");
    return this.db.shop.findMany({ where: { platform: "SHOPIFY", status: "ACTIVE", uninstalledAt: null,
      reinstallPendingAt: null, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: "asc" }, take: limit,
      select: { id: true, domain: true, installedAt: true } });
  }
  claim(shop: NameShop, now: Date): Promise<NameClaim | null> {
    return this.edit(shop.id, shop.domain, shop.installedAt.toISOString(), now, (state) => {
      if ((state.nextDueAt && Date.parse(state.nextDueAt) > now.getTime()) ||
          (state.leaseUntil && Date.parse(state.leaseUntil) > now.getTime())) return null;
      const leaseOwner = randomUUID(); const leaseUntil = new Date(now.getTime() + NAME_LEASE_MS).toISOString();
      return { state: { ...state, leaseOwner, leaseUntil }, value: {
        shopId: shop.id, domain: shop.domain, installedAt: shop.installedAt.toISOString(), leaseOwner, leaseUntil } };
    });
  }
  complete(claim: NameClaim, name: string, now: Date): Promise<boolean> {
    if (!name.trim() || name.length > 2048 || [...name].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
      throw new Error("INVALID_SHOP_NAME");
    }
    return this.finish(claim, now, state => ({ state: { ...state, lastSuccessfulAt: now.toISOString(),
      nextDueAt: new Date(now.getTime() + NAME_REFRESH_MS).toISOString(), attempts: 0,
      failureCode: null, leaseOwner: null, leaseUntil: null }, name: name.trim() }));
  }
  fail(claim: NameClaim, code: string, retryable: boolean, retryAfterMs: number, now: Date): Promise<boolean> {
    if (!/^[A-Z_]{1,64}$/.test(code) || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) throw new Error("INVALID_NAME_FAILURE");
    return this.finish(claim, now, state => {
      const attempts = Math.min(5, state.attempts + 1);
      return { state: { ...state, attempts, failureCode: code, leaseOwner: null, leaseUntil: null,
        nextDueAt: new Date(now.getTime() + Math.min(NAME_REFRESH_MS,
          retryable ? Math.max(NAME_RETRY_MS[attempts - 1]!, retryAfterMs) : NAME_REFRESH_MS)).toISOString() } };
    });
  }
  private async finish(claim: NameClaim, now: Date, update: (state: NameSync) => { state: NameSync; name?: string }): Promise<boolean> {
    return (await this.edit(claim.shopId, claim.domain, claim.installedAt, now, state => {
      if (state.leaseOwner !== claim.leaseOwner || state.leaseUntil !== claim.leaseUntil || Date.parse(claim.leaseUntil) <= now.getTime()) return null;
      return { ...update(state), value: true };
    })) ?? false;
  }
  private async edit<T>(shopId: string, domain: string, installedAt: string, now: Date,
    update: (state: NameSync) => { state: NameSync; name?: string; value: T } | null): Promise<T | null> {
    if (!Number.isFinite(now.getTime())) throw new Error("INVALID_NAME_CLOCK");
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
          const state = syncState((document as typeof document & { shopifySourceSync?: unknown }).shopifySourceSync);
          const result = update(state);
          if (!result) return null;
          await tx.shopBrand.update({ where: { shopId }, data: {
            ...(result.name === undefined ? {} : { brandName: result.name, fetchedAt: now }),
            whatsAppMedia: { ...document, shopifySourceSync: result.state } as unknown as Prisma.InputJsonValue,
          } });
          return result.value;
        }, { timeout: 10_000, maxWait: 5_000 });
      } catch (error) {
        if (attempt < 2 && error && typeof error === "object" && "code" in error &&
            (error.code === "P2034" || error.code === "P2002")) continue;
        throw error;
      }
    }
  }
}
