import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { PrismaShopBrandMediaReader } from "../../src/services/shop-brand-media-runtime/repository.js";
import { ShopBrandReadyMediaAdapter } from "../../src/services/shop-brand-media-runtime/resolver.js";

const integration = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;
const hash = "a".repeat(64);
const fingerprint = `sha256:${"b".repeat(64)}`;
const publicOrigin = "https://shop-brands.modainteract.com/";
function image(shopId: string, role: "LOGO" | "SQUARE_LOGO" | "COVER_IMAGE") {
  return { schemaVersion: 1, roles: { [role]: {
    source: { url: "https://shop.example/original.png", reference: null, fingerprint,
      generation: 1, observedAt: "2026-10-27T09:00:00Z" },
    work: { status: "READY", attempts: 1, retryAfter: null, leaseOwner: null,
      leaseUntil: null, failureCode: null, lastCheckedAt: "2026-10-27T09:02:00Z" },
    ready: { sourceGeneration: 1, sourceFingerprint: fingerprint,
      objectKey: `shop-brands/${shopId}/${role.toLowerCase()}/sha256-${hash}.jpg`,
      contentType: "image/jpeg", width: 1125, height: 600, sizeBytes: 42000,
      contentSha256: hash, verifiedAt: "2026-10-27T09:02:00Z" },
  } } };
}

integration("ARCH-049 BG004 PostgreSQL tenant-scoped READY reads", () => {
  it("reads only the authenticated shop, verifies every role, and rejects stale persisted metadata", async () => {
    const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
    const suffix = randomUUID().replaceAll("-", "");
    const ids = [`arch049mediaA_${suffix}`, `arch049mediaB_${suffix}`];
    try {
      await db.shop.createMany({ data: ids.map((id) => ({ id, domain: `${id}.shop.example.test`, status: "ACTIVE" as const })) });
      const roles = ["LOGO", "SQUARE_LOGO", "COVER_IMAGE"] as const;
      for (const role of roles) {
        // Distinct shops and roles with immutable keys; no read can use the other tenant.
        await db.shopBrand.upsert({ where: { shopId: ids[0] }, create: { shopId: ids[0]!,
          whatsAppMedia: image(ids[0]!, role) as Prisma.InputJsonValue },
          update: { whatsAppMedia: image(ids[0]!, role) as Prisma.InputJsonValue } });
        const adapter = new ShopBrandReadyMediaAdapter(new PrismaShopBrandMediaReader(db),
          async () => ({ publicOrigin }));
        expect((await adapter.resolve(ids[0]!, role))?.httpsUrl)
          .toBe(`${publicOrigin}shop-brands/${ids[0]}/${role.toLowerCase()}/sha256-${hash}.jpg`);
        expect(await adapter.resolve(ids[1]!, role)).toBeNull();
      }
      // A generation mismatch invalidates the retained previous READY image.
      const stale = image(ids[0]!, "LOGO");
      stale.roles.LOGO!.source.generation = 2;
      await db.shopBrand.update({ where: { shopId: ids[0] },
        data: { whatsAppMedia: stale as Prisma.InputJsonValue } });
      const adapter = new ShopBrandReadyMediaAdapter(new PrismaShopBrandMediaReader(db),
        async () => ({ publicOrigin }));
      expect(await adapter.resolve(ids[0]!, "LOGO")).toBeNull();
    } finally {
      await db.shop.deleteMany({ where: { id: { in: ids } } });
      await db.$disconnect();
    }
  }, 40_000);
});
