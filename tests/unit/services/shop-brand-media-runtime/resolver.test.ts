import { describe, expect, it, vi } from "vitest";
import {
  ShopBrandReadyMediaAdapter, verifiedReadyMedia, verifiedPublicMediaOrigin,
} from "../../../../src/services/shop-brand-media-runtime/resolver.js";
import { PrismaShopBrandMediaReader } from "../../../../src/services/shop-brand-media-runtime/repository.js";

const hash = "a".repeat(64);
const fingerprint = `sha256:${"b".repeat(64)}`;
const publicOrigin = "https://shop-brands.modainteract.com/";
const role = "LOGO" as const;
function readyDocument(_shopId = "shop-1", selectedRole: "LOGO" | "SQUARE_LOGO" | "COVER_IMAGE" = role, override: {
  source?: Record<string, unknown>; ready?: Record<string, unknown>;
  work?: Record<string, unknown>; status?: string;
} = {}, domain = "shop.example") {
  return { schemaVersion: 1, roles: { [selectedRole]: {
    source: { url: "https://merchant.example/source.png", reference: null,
      generation: 3, fingerprint, observedAt: "2026-10-27T09:00:00Z", ...override.source },
    work: { status: override.status ?? "READY", attempts: 1, retryAfter: null,
      leaseOwner: null, leaseUntil: null, failureCode: null, lastCheckedAt: "2026-10-27T09:02:00Z",
      ...override.work },
    ready: { sourceGeneration: 3, sourceFingerprint: fingerprint,
      objectKey: `shop-brands/${domain}/${selectedRole.toLowerCase()}/sha256-${hash}.jpg`,
      contentType: "image/jpeg", width: 1125, height: 600, sizeBytes: 42000,
      contentSha256: hash, verifiedAt: "2026-10-27T09:02:00Z", ...override.ready },
  } } };
}
const expected = `https://shop-brands.modainteract.com/shop-brands/shop.example/logo/sha256-${hash}.jpg`;
const verify = (media: unknown, selectedRole: "LOGO" | "SQUARE_LOGO" | "COVER_IMAGE" = role,
  shopId = "shop-1", domain = "https://shop.example") =>
  verifiedReadyMedia({ shopId, domain, role: selectedRole, whatsAppMedia: media,
    publicOrigin: verifiedPublicMediaOrigin(publicOrigin) });

describe("ARCH-049-BACKGROUND-004 tenant-scoped READY derivation", () => {
  it.each(["LOGO", "SQUARE_LOGO", "COVER_IMAGE"] as const)("resolves %s by current generation, never by original URL", (selectedRole) => {
    const media = readyDocument("shop-1", selectedRole);
    expect(verify(media, selectedRole)).toEqual({ shopId: "shop-1", role: selectedRole,
      status: "READY", kind: "R2_DERIVATIVE",
      httpsUrl: expected.replace("/logo/", `/${selectedRole.toLowerCase()}/`) });
  });

  it("accepts PNG only with its exact immutable .png key", () => {
    const png = readyDocument("shop-1", role, { ready: {
      contentType: "image/png", objectKey: `shop-brands/shop.example/logo/sha256-${hash}.png`,
    } });
    expect(verify(png)?.httpsUrl).toBe(expected.replace(".jpg", ".png"));
  });

  it("rejects source deletion, stale generation and mismatched fingerprint during role updates", () => {
    const document = readyDocument();
    expect(verify(readyDocument("shop-1", role, { source: { url: null } }))).toBeNull();
    expect(verify(readyDocument("shop-1", role, { source: { generation: 4 } }))).toBeNull();
    expect(verify(readyDocument("shop-1", role, { source: { fingerprint: `sha256:${"c".repeat(64)}` } }))).toBeNull();
    expect(verify(readyDocument("shop-1", role, { ready: { sourceFingerprint: "broken" } }))).toBeNull();
    expect(verify(readyDocument("shop-1", role, { work: { refresh: { attempts: 2,
      leaseOwner: "other", leaseUntil: "2026-10-28T09:00:00Z" } } }))).not.toBeNull();
    for (const status of ["MISSING", "PENDING", "PROCESSING", "FAILED"]) {
      expect(verify({ ...document, roles: { LOGO: { ...document.roles.LOGO,
        work: { ...document.roles.LOGO!.work, status } } } })).toBeNull();
    }
  });

  it("rejects a foreign-shop key, role swap, key/path spoofing and bad output metadata", () => {
    for (const ready of [
      { objectKey: `shop-brands/other.example/logo/sha256-${hash}.jpg` },
      { objectKey: `shop-brands/shop.example/cover_image/sha256-${hash}.jpg` },
      { objectKey: "shop-brands/shop.example/logo/../other.jpg" },
      { objectKey: `shop-brands/shop.example/logo/sha256-${"c".repeat(64)}.jpg` },
      { objectKey: `shop-brands/shop-1/logo/sha256-${hash}.jpg` },
      { objectKey: `shop-brands/c2hvcC5leGFtcGxl/logo/sha256-${hash}.jpg` },
      { contentType: "image/gif" }, { contentType: "image/png" },
      { width: 0 }, { width: 1126 }, { height: 599 },
      { sizeBytes: 0 }, { sizeBytes: 5 * 1024 * 1024 },
      { contentSha256: "invalid" }, { verifiedAt: "not-date" },
    ]) expect(verify(readyDocument("shop-1", role, { ready }))).toBeNull();
    expect(verify({})).toBeNull();
    expect(verify({ schemaVersion: 2, roles: {} })).toBeNull();
    expect(verify({ schemaVersion: 1, roles: { LOGO: null } })).toBeNull();
    expect(verify(readyDocument("shop-2", role, {}, "other.example"))).toBeNull();
  });

  it("uses the current normalized Shop.domain, including safe bare one-label values", () => {
    const rawDomain = "https://Store.Example/path?ignored=yes";
    const media = readyDocument("shop-1", role, {}, "store.example");
    expect(verify(media, role, "shop-1", rawDomain)?.httpsUrl)
      .toBe(expected.replace("shop.example", "store.example"));
    const oneLabel = readyDocument("shop-1", role, {}, "example");
    expect(verify(oneLabel, role, "shop-1", "example")?.httpsUrl)
      .toBe(expected.replace("shop.example", "example"));
    for (const unsafeDomain of ["../escape", "bad/domain", "bad?query", "bad#fragment", "a".repeat(254)]) {
      expect(verify(readyDocument("shop-1", role, {}, "shop.example"), role,
        "shop-1", unsafeDomain)).toBeNull();
    }
  });

  it("trusts only a configured HTTPS origin and never accepts a different CDN host or path", () => {
    for (const badOrigin of [undefined, null, "", "http://media.modainteract.com/",
      "https://media.modainteract.com/subpath/", "https://evil.test/", "https://media.modainteract.com/?redirect=evil",
      "https://user:pass@media.modainteract.com/", "https://127.0.0.1/", "https://media.modainteract.com:8080/"]) {
      expect(() => verifiedPublicMediaOrigin(badOrigin)).toThrow("SHOPBRAND_PUBLIC_ORIGIN_INVALID");
    }
    expect(verifiedReadyMedia({ shopId: "shop-1", domain: "shop.example", role, whatsAppMedia: readyDocument(),
      publicOrigin: new URL("http://assets.modainteract.com/") })).toBeNull();
    const safe = verifiedPublicMediaOrigin("https://assets.modainteract.com");
    expect(verifiedReadyMedia({ shopId: "shop-1", domain: "shop.example", role, whatsAppMedia: readyDocument(),
      publicOrigin: safe })?.httpsUrl).toBe(expected.replace("shop-brands.modainteract.com", "assets.modainteract.com"));
  });

  it("performs an exact shopId Prisma lookup, reads current domain and checks returned tenant", async () => {
    const findUnique = vi.fn(async () => ({ shopId: "shop-1", shop: { domain: "shop.example" },
      whatsAppMedia: readyDocument() }));
    const repo = new PrismaShopBrandMediaReader({ shopBrand: { findUnique } } as never);
    const settings = vi.fn(async () => ({ publicOrigin }));
    const adapter = new ShopBrandReadyMediaAdapter(repo, settings);
    expect(await adapter.resolve("shop-1", "LOGO")).toMatchObject({ httpsUrl: expected });
    expect(findUnique).toHaveBeenCalledWith({ where: { shopId: "shop-1" },
      select: { shopId: true, whatsAppMedia: true, shop: { select: { domain: true } } } });
    expect(await adapter.approvedHosts()).toEqual(["shop-brands.modainteract.com"]);
    expect(findUnique).toHaveBeenCalledTimes(1);
    findUnique.mockResolvedValueOnce({ shopId: "shop-2", shop: { domain: "other.example" },
      whatsAppMedia: readyDocument("shop-2", role, {}, "other.example") });
    expect(await adapter.resolve("shop-1", "LOGO")).toBeNull();
    expect(await adapter.resolve("shop/../other", "LOGO")).toBeNull();
    expect(await adapter.resolve("shop-1", "headerImage" as never)).toBeNull();
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("propagates operational configuration/database failures for shared-logger retry ownership", async () => {
    const failure = new Error("sensitive private URL or token");
    const repo = { readForShop: vi.fn(async () => { throw failure; }) };
    const adapter = new ShopBrandReadyMediaAdapter(repo, async () => ({ publicOrigin }));
    await expect(adapter.resolve("shop-1", "LOGO")).rejects.toBe(failure);
    const config = new ShopBrandReadyMediaAdapter(repo, async () => { throw failure; });
    await expect(config.resolve("shop-1", "LOGO")).rejects.toBe(failure);
    const absentConfig = new ShopBrandReadyMediaAdapter(repo, async () => ({ publicOrigin: undefined as never }));
    await expect(absentConfig.resolve("shop-1", "LOGO")).rejects.toThrow("SHOPBRAND_PUBLIC_ORIGIN_INVALID");
    expect(repo.readForShop).toHaveBeenCalledTimes(1);
  });
});
