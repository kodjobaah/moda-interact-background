import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { createShopBrandR2Writer, SHOP_BRAND_CACHE_CONTROL,
  type BrandR2Transport } from "../../../../src/services/shop-brand-media/r2-writer.js";
import { loadShopBrandR2Credentials } from "../../../../src/services/shop-brand-media/r2-config.js";
import type { VerifiedBrandImage } from "../../../../src/services/shop-brand-media/contracts.js";

const bucket = "moda-interact-shop-brands";
const image = async (): Promise<VerifiedBrandImage> => {
  const bytes = await sharp({ create: { width: 1125, height: 600, channels: 3,
    background: "white" } }).jpeg().toBuffer();
  return { bytes, contentType: "image/jpeg", width: 1125, height: 600,
    sizeBytes: bytes.length, contentSha256: createHash("sha256").update(bytes).digest("hex") };
};
const notFound = () => Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } });
const conflict = () => Object.assign(new Error("collision"), { $metadata: { httpStatusCode: 412 } });

describe("ARCH-049 dedicated immutable R2 writer", () => {
  it("puts with conditional immutability, verifies HEAD metadata and idempotently reuses", async () => {
    const fixture = await image();
    const objectKey = `shop-brands/shop-1/logo/sha256-${fixture.contentSha256}.jpg`;
    let persisted = false;
    const head = vi.fn(async () => {
      if (!persisted) throw notFound();
      return { ContentType: fixture.contentType, ContentLength: fixture.sizeBytes,
        Metadata: { sha256: fixture.contentSha256 }, CacheControl: SHOP_BRAND_CACHE_CONTROL };
    });
    const put = vi.fn(async () => { persisted = true; });
    const writer = createShopBrandR2Writer({ head, put });
    await writer.putVerified({ bucket, objectKey, image: fixture });
    await writer.putVerified({ bucket, objectKey, image: fixture });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      Bucket: bucket, Key: objectKey, Body: fixture.bytes,
      ContentType: "image/jpeg", ContentLength: fixture.sizeBytes,
      CacheControl: "public, max-age=31536000, immutable",
      IfNoneMatch: "*", Metadata: { sha256: fixture.contentSha256 },
    }));
    expect(head).toHaveBeenCalledTimes(3);
  });

  it("verifies after a simultaneous writer wins the conditional PUT race", async () => {
    const fixture = await image();
    const objectKey = `shop-brands/shop-1/logo/sha256-${fixture.contentSha256}.jpg`;
    let exists = false;
    const transport: BrandR2Transport = {
      head: vi.fn(async () => {
        if (!exists) throw notFound();
        return { ContentType: fixture.contentType, ContentLength: fixture.sizeBytes,
          Metadata: { sha256: fixture.contentSha256 }, CacheControl: SHOP_BRAND_CACHE_CONTROL };
      }),
      put: vi.fn(async () => { exists = true; throw conflict(); }),
    };
    await expect(createShopBrandR2Writer(transport).putVerified({ bucket, objectKey, image: fixture }))
      .resolves.toBeUndefined();
  });

  it("fails closed for an existing object with different metadata", async () => {
    const fixture = await image();
    const objectKey = `shop-brands/shop-1/logo/sha256-${fixture.contentSha256}.jpg`;
    const transport: BrandR2Transport = { head: async () => ({
      ContentType: "image/jpeg", ContentLength: fixture.sizeBytes, Metadata: { sha256: "wrong" },
      CacheControl: SHOP_BRAND_CACHE_CONTROL,
    }), put: vi.fn() };
    await expect(createShopBrandR2Writer(transport).putVerified({ bucket, objectKey, image: fixture }))
      .rejects.toMatchObject({ code: "R2_OBJECT_MISMATCH" });
    expect(transport.put).not.toHaveBeenCalled();
  });

  it("rejects malformed source-derived object keys and bytes/hash inconsistencies", async () => {
    const fixture = await image();
    const transport: BrandR2Transport = { head: vi.fn(), put: vi.fn() };
    const writer = createShopBrandR2Writer(transport);
    for (const objectKey of ["shop-brands/../logo/image.jpg",
      `shop-brands/other/logo/sha256-${fixture.contentSha256}.png`]) {
      await expect(writer.putVerified({ bucket, objectKey, image: fixture }))
        .rejects.toMatchObject({ code: "OUTPUT_VERIFICATION_FAILED" });
    }
    await expect(writer.putVerified({ bucket,
      objectKey: `shop-brands/shop-1/logo/sha256-${fixture.contentSha256}.jpg`,
      image: { ...fixture, contentSha256: "0".repeat(64) } }))
      .rejects.toMatchObject({ code: "OUTPUT_VERIFICATION_FAILED" });
    expect(transport.head).not.toHaveBeenCalled();
  });

  it("distinguishes R2 transient availability from permanent write denial", async () => {
    const fixture = await image();
    const objectKey = `shop-brands/shop-1/logo/sha256-${fixture.contentSha256}.jpg`;
    for (const [httpStatusCode, retryable] of [[503, true], [409, true], [403, false]] as const) {
      const writer = createShopBrandR2Writer({
        head: async () => { throw { $metadata: { httpStatusCode } }; }, put: vi.fn(),
      });
      await expect(writer.putVerified({ bucket, objectKey, image: fixture }))
        .rejects.toMatchObject({ code: "R2_UNAVAILABLE", retryable });
    }
  });

  it("requires dedicated credentials and a strict Cloudflare R2 HTTPS origin, not Merchant Knowledge secrets", () => {
    expect(() => loadShopBrandR2Credentials({})).toThrowError(/R2_CONFIGURATION_INVALID/);
    const safe = { SHOPBRAND_R2_ENDPOINT: "https://account123.r2.cloudflarestorage.com",
      SHOPBRAND_R2_ACCESS_KEY_ID: "brand-worker", SHOPBRAND_R2_SECRET_ACCESS_KEY: "brand-secret" };
    expect(loadShopBrandR2Credentials({ ...safe })).toEqual({ endpoint: safe.SHOPBRAND_R2_ENDPOINT,
      accessKeyId: "brand-worker", secretAccessKey: "brand-secret" });
    for (const endpoint of ["http://account123.r2.cloudflarestorage.com", "https://localhost",
      "https://user:pass@account123.r2.cloudflarestorage.com",
      "https://account123.r2.cloudflarestorage.com/private",
      "https://account123.r2.cloudflarestorage.com?secret=yes"]) {
      expect(() => loadShopBrandR2Credentials({ ...safe, SHOPBRAND_R2_ENDPOINT: endpoint }))
        .toThrowError(/R2_CONFIGURATION_INVALID/);
    }
    expect(() => loadShopBrandR2Credentials({
      ...safe, SHOPBRAND_R2_ACCESS_KEY_ID: undefined, MERCHANT_KNOWLEDGE_R2_ACCESS_KEY_ID: "other-secret",
    })).toThrowError(/R2_CONFIGURATION_INVALID/);
    expect(() => loadShopBrandR2Credentials({
      ...safe, SHOPBRAND_R2_SECRET_ACCESS_KEY: `secret${String.fromCharCode(1)}suffix`,
    })).toThrowError(/R2_CONFIGURATION_INVALID/);
  });
});
