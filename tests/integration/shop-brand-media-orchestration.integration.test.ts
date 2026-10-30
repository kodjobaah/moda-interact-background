import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { ShopBrandMediaRepository } from "../../src/services/shop-brand-media-orchestration/repository.js";
import { parseBrandDocument, currentReady } from "../../src/services/shop-brand-media-orchestration/state.js";
import { normalizeShopBrandDomain } from "../../src/services/shop-brand-media/contracts.js";

const url = process.env.TEST_DATABASE_URL;
const describeDb = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
const T0 = new Date("2026-10-01T00:00:00.000Z");
const at = (days: number) => new Date(T0.getTime() + days * 86_400_000);
const auditLogger = { warn: () => undefined, error: () => undefined };
const HASH = "a".repeat(64);
const HASH2 = "b".repeat(64);
const fingerprint = `sha256:${HASH}`;
const source = (shopId: string, role: "LOGO" | "COVER_IMAGE", url: string | null, time = T0) => ({
  shopId, role, sourceUrl: url, sourceReference: "shopify:test", sourceFingerprint: url ? fingerprint : null,
  observedAt: time.toISOString(),
});
const outcome = (domain: string, role: "LOGO" | "COVER_IMAGE", generation: number, digest = HASH, verifiedAt = at(0.001)) => ({
  result: { sourceGeneration: generation, sourceFingerprint: fingerprint,
    contentType: "image/jpeg" as const, width: 1125, height: 600, sizeBytes: 1000,
    contentSha256: digest, objectKey: `shop-brands/${normalizeShopBrandDomain(domain)}/${role.toLowerCase()}/sha256-${digest}.jpg` },
  verifiedAt: verifiedAt.toISOString(),
});

async function shop(db: PrismaClient): Promise<string> {
  const id = `arch049_${randomUUID()}`;
  await db.shop.create({ data: { id, domain: `shop-${randomUUID()}.myshopify.com`, platform: "SHOPIFY" } });
  return id;
}

// Uses the project's disposable Postgres runner; never calls a real R2 host.
describeDb("ARCH-049 BG002 PostgreSQL serialisation and crash reconciliation", () => {
  it("initialises the unique shop row concurrently and does not clobber other roles", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const id = await shop(db);
    try {
      const repo = new ShopBrandMediaRepository(db, auditLogger);
      const [logo, cover] = await Promise.all([
        repo.observeSource(source(id, "LOGO", "https://test.example/logo.png")),
        repo.observeSource(source(id, "COVER_IMAGE", "https://test.example/cover.png")),
      ]);
      expect(logo.generation).toBe(1);
      expect(cover.generation).toBe(1);
      expect(await db.shopBrand.count({ where: { shopId: id } })).toBe(1);
      const stored = parseBrandDocument((await db.shopBrand.findUniqueOrThrow({ where: { shopId: id } })).whatsAppMedia);
      expect(stored.roles.LOGO?.source.url).toBe("https://test.example/logo.png");
      expect(stored.roles.COVER_IMAGE?.source.url).toBe("https://test.example/cover.png");
      expect((await repo.observeSource(source(id, "LOGO", "https://test.example/logo.png", at(1)))).changed).toBe(false);
      expect((await repo.observeSource(source(id, "LOGO", "https://test.example/stale.png", T0))).generation).toBe(1);
      expect((await repo.observeSource(source(id, "LOGO", "https://test.example/new.png", at(2)))).generation).toBe(2);
      const changed = parseBrandDocument((await db.shopBrand.findUniqueOrThrow({ where: { shopId: id } })).whatsAppMedia);
      expect(changed.roles.COVER_IMAGE?.source.url).toBe("https://test.example/cover.png");
    } finally {
      await db.shop.delete({ where: { id } });
      await db.$disconnect();
    }
  });

  it("allows one claimant, rejects stale completion and preserves the last current-generation READY during refresh", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const id = await shop(db);
    try {
      const one = new ShopBrandMediaRepository(db, auditLogger);
      const two = new ShopBrandMediaRepository(db, auditLogger);
      await one.observeSource(source(id, "LOGO", "https://test.example/logo.jpg"));
      const claims = await Promise.all([one.claim(id, "LOGO", at(0.001)), two.claim(id, "LOGO", at(0.001))]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const holder = claims.find(Boolean)!;
      expect(await two.complete({ ...holder, leaseOwner: randomUUID() }, outcome(holder.domain, "LOGO", 1), at(0.002))).toBe(false);
      expect(await one.complete(holder, outcome(holder.domain, "LOGO", 1), at(0.002))).toBe(true);
      const ready = parseBrandDocument((await db.shopBrand.findUniqueOrThrow({ where: { shopId: id } })).whatsAppMedia);
      expect(currentReady(ready.roles.LOGO!)).not.toBeNull();
      const refresh = await two.claim(id, "LOGO", at(9));
      expect(refresh?.kind).toBe("refresh");
      const refreshing = parseBrandDocument((await db.shopBrand.findUniqueOrThrow({ where: { shopId: id } })).whatsAppMedia);
      expect(refreshing.roles.LOGO?.work.status).toBe("READY");
      expect(currentReady(refreshing.roles.LOGO!)).not.toBeNull();
      expect(await two.fail(refresh!, "SOURCE_TIMEOUT", true, at(9.0001))).toBe(true);
      const failed = parseBrandDocument((await db.shopBrand.findUniqueOrThrow({ where: { shopId: id } })).whatsAppMedia);
      expect(currentReady(failed.roles.LOGO!)).not.toBeNull();
      expect(failed.roles.LOGO?.work.refresh?.failureCode).toBe("SOURCE_TIMEOUT");
      const newer = await two.claim(id, "LOGO", at(9.01));
      expect(newer?.kind).toBe("refresh");
      expect(await one.complete(newer!, outcome(newer!.domain, "LOGO", 1, HASH2, at(9.0101)), at(9.0101))).toBe(true);
      const latest = parseBrandDocument((await db.shopBrand.findUniqueOrThrow({ where: { shopId: id } })).whatsAppMedia);
      expect(latest.roles.LOGO?.ready?.contentSha256).toBe(HASH2);
      await one.observeSource(source(id, "LOGO", "https://test.example/updated.jpg", at(10)));
      expect(await two.claim(id, "LOGO", at(11))).toMatchObject({ generation: 2, kind: "initial" });
      expect(await one.complete(holder, outcome(holder.domain, "LOGO", 1), at(11))).toBe(false);
      const pending = parseBrandDocument((await db.shopBrand.findUniqueOrThrow({ where: { shopId: id } })).whatsAppMedia);
      expect(currentReady(pending.roles.LOGO!)).toBeNull();
    } finally {
      await db.shop.delete({ where: { id } });
      await db.$disconnect();
    }
  });

  it("reconstructs pending work from JSONB after a new repository instance and handles source removal", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const id = await shop(db);
    try {
      const beforeRestart = new ShopBrandMediaRepository(db, auditLogger);
      await beforeRestart.observeSource(source(id, "LOGO", "https://test.example/a.png"));
      const afterRestart = new ShopBrandMediaRepository(db, auditLogger);
      const page = await afterRestart.listPage(null, 100);
      const row = page.find((candidate) => candidate.shopId === id);
      expect(parseBrandDocument(row!.whatsAppMedia).roles.LOGO?.work.status).toBe("PENDING");
      const recovered = await afterRestart.claim(id, "LOGO", at(0.001));
      expect(recovered).not.toBeNull();
      await afterRestart.observeSource(source(id, "LOGO", null, at(1)));
      expect(await beforeRestart.complete(recovered!, outcome(recovered!.domain, "LOGO", 1), at(1.1))).toBe(false);
      const removed = parseBrandDocument((await db.shopBrand.findUniqueOrThrow({ where: { shopId: id } })).whatsAppMedia);
      expect(removed.roles.LOGO?.work.status).toBe("MISSING");
      expect(removed.roles.LOGO?.source.generation).toBe(2);
    } finally {
      await db.shop.delete({ where: { id } });
      await db.$disconnect();
    }
  });
});
