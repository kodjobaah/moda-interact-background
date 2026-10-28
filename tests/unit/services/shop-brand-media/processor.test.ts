import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  createShopBrandMediaProcessor, publicBrandImageUrl,
} from "../../../../src/services/shop-brand-media/processor.js";
import { createShopBrandImageTransformer } from "../../../../src/services/shop-brand-media/image-transformer.js";
import { createShopBrandPublicMediaProbe } from "../../../../src/services/shop-brand-media/public-probe.js";
import { ShopBrandMediaError, encodeShopBrandDomain, type ShopBrandMediaInput } from "../../../../src/services/shop-brand-media/contracts.js";

const configuration = { publicOrigin: "https://shop-brands.modainteract.com",
  bucketName: "moda-interact-shop-brands" };
const source: ShopBrandMediaInput = { shopId: "shop-123", domain: "merchant.example.org", role: "LOGO",
  sourceUrl: "https://merchant.example.org/logo.png?token=should-not-log",
  sourceFingerprint: `sha256:${"a".repeat(64)}`, sourceGeneration: 3 };
const fixture = async () => sharp({ create: { width: 60, height: 30, channels: 3,
  background: "#123456" } }).png().toBuffer();

describe("ARCH-049 media processor / public readiness", () => {
  it("uses the canonical v1 UTF-8 base64url Shop.domain path vector", () => {
    expect(encodeShopBrandDomain("Store.example.org")).toBe("v1-U3RvcmUuZXhhbXBsZS5vcmc");
  });

  it("calls isolated dependencies, never writes DB state, and returns only verified media metadata", async () => {
    const bytes = await fixture();
    const fetch = vi.fn(async () => ({ bytes, declaredContentType: "text/plain" }));
    const writer = { putVerified: vi.fn(async (_input: unknown) => {}) };
    const probe = { verify: vi.fn(async (_input: unknown) => {}) };
    const logger = { info: vi.fn(), error: vi.fn() };
    const process = createShopBrandMediaProcessor({
      readConfiguration: async () => configuration,
      fetcher: { fetch }, transformer: createShopBrandImageTransformer(), writer, probe, logger,
    });
    const result = await process.process(source);
    expect(result).toMatchObject({
      objectKey: expect.stringMatching(/^shop-brands\/v1-[A-Za-z0-9_-]+\/logo\/sha256-[a-f0-9]{64}\.jpg$/),
      contentType: "image/jpeg", width: 1125, height: 600,
      sourceGeneration: 3, sourceFingerprint: source.sourceFingerprint,
    });
    expect(result.contentSha256).toHaveLength(64);
    expect(result).not.toHaveProperty("bytes");
    expect(fetch).toHaveBeenCalledWith(source.sourceUrl);
    expect(writer.putVerified).toHaveBeenCalledOnce();
    expect(writer.putVerified.mock.calls[0]?.[0]).toMatchObject({ bucket: configuration.bucketName,
      objectKey: result.objectKey });
    expect(probe.verify).toHaveBeenCalledWith({
      url: `https://shop-brands.modainteract.com/${result.objectKey}`,
      image: expect.objectContaining({ contentSha256: result.contentSha256 }),
    });
    expect(logger.info).toHaveBeenCalledWith("shop_brand.media.verified",
      expect.objectContaining({ shopId: source.shopId, role: "LOGO",
        configurationPurpose: "merchant.knowledge.r2" }));
  });

  it("withholds READY when the public HTTPS domain does not deliver matching image bytes/content type", async () => {
    const bytes = await fixture();
    const image = await createShopBrandImageTransformer().transform(bytes, "LOGO");
    const url = `https://shop-brands.modainteract.com/shop-brands/${encodeShopBrandDomain(source.domain)}/logo/sha256-${image.contentSha256}.jpg`;
    await expect(createShopBrandPublicMediaProbe({ fetch: async () => ({
      bytes: image.bytes, declaredContentType: "image/png",
    }) }).verify({ url, image })).rejects.toMatchObject({ code: "PUBLIC_MEDIA_MISMATCH", retryable: true });
    await expect(createShopBrandPublicMediaProbe({ fetch: async () => {
      throw new ShopBrandMediaError("SOURCE_UNAVAILABLE", true);
    } }).verify({ url, image })).rejects.toMatchObject({ code: "PUBLIC_MEDIA_UNAVAILABLE", retryable: true });
    await expect(createShopBrandPublicMediaProbe({ fetch: async () => ({
      bytes: Buffer.from("wrong"), declaredContentType: "image/jpeg",
    }) }).verify({ url, image })).rejects.toMatchObject({ code: "PUBLIC_MEDIA_MISMATCH" });
    await expect(createShopBrandPublicMediaProbe({ fetch: async () => ({
      bytes: image.bytes, declaredContentType: image.contentType,
    }) }).verify({ url, image })).resolves.toBeUndefined();
    expect(createHash("sha256").update(image.bytes).digest("hex")).toBe(image.contentSha256);
  });

  it("never logs an unknown provider exception, sensitive URL or credentials", async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const processor = createShopBrandMediaProcessor({
      readConfiguration: async () => configuration,
      fetcher: { fetch: async () => { throw new Error("Bearer SECRET at " + source.sourceUrl); } },
      transformer: createShopBrandImageTransformer(),
      writer: { putVerified: vi.fn() }, probe: { verify: vi.fn() }, logger,
    });
    await expect(processor.process(source)).rejects.toMatchObject({ code: "UNEXPECTED_FAILURE", retryable: true });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("SECRET");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("token=");
    expect(logger.error).toHaveBeenCalledWith("shop_brand.media.failed",
      expect.objectContaining({ reasonCode: "UNEXPECTED_FAILURE", retryable: true }));
  });

  it("logs the R2 configuration purpose and bounded provider diagnostic", async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const processor = createShopBrandMediaProcessor({
      readConfiguration: async () => configuration,
      fetcher: { fetch: async () => ({ bytes: await fixture(), declaredContentType: "image/png" }) },
      transformer: createShopBrandImageTransformer(),
      writer: { putVerified: async () => {
        throw new ShopBrandMediaError("R2_UNAVAILABLE", false, "Access denied for [REDACTED]");
      } },
      probe: { verify: vi.fn() }, logger,
    });
    await expect(processor.process(source)).rejects.toMatchObject({ code: "R2_UNAVAILABLE" });
    expect(logger.error).toHaveBeenCalledWith("shop_brand.media.failed", expect.objectContaining({
      configurationPurpose: "merchant.knowledge.r2",
      providerMessage: "Access denied for [REDACTED]",
    }));
  });

  it("refuses mismatched transform metadata and does not upload or probe", async () => {
    const bytes = await fixture();
    const real = await createShopBrandImageTransformer().transform(bytes, "COVER_IMAGE");
    const writer = { putVerified: vi.fn() };
    const probe = { verify: vi.fn() };
    const processor = createShopBrandMediaProcessor({
      readConfiguration: async () => configuration,
      fetcher: { fetch: async () => ({ bytes, declaredContentType: "image/png" }) },
      transformer: { transform: async () => ({ ...real, contentSha256: "a".repeat(64) }) },
      writer, probe,
    });
    await expect(processor.process({ ...source, role: "COVER_IMAGE" })).rejects
      .toMatchObject({ code: "OUTPUT_VERIFICATION_FAILED" });
    expect(writer.putVerified).not.toHaveBeenCalled();
    expect(probe.verify).not.toHaveBeenCalled();
  });

  it("only builds public origin URLs with encoded path keys, never arbitrary external URLs", () => {
    const key = `shop-brands/${encodeShopBrandDomain("store.example.org")}/logo/sha256-${"b".repeat(64)}.png`;
    expect(publicBrandImageUrl("https://shop-brands.modainteract.com", key))
      .toBe(`https://shop-brands.modainteract.com/${key}`);
    expect(() => publicBrandImageUrl("http://shop-brands.modainteract.com", key)).toThrow();
    expect(() => publicBrandImageUrl("https://shop-brands.modainteract.com/untrusted", key)).toThrow();
    expect(() => publicBrandImageUrl("https://shop-brands.modainteract.com", "shop-brands/../evil"))
      .toThrow();
    for (const domain of ["Store.example.org", "store.example.org/path", "user@store.example.org",
      "store.example.org:443", "store..example.org", "store.example.org.", "store.example.org\n"]) {
      expect(() => publicBrandImageUrl("https://shop-brands.modainteract.com",
        `shop-brands/${domain}/logo/sha256-${"b".repeat(64)}.jpg`)).toThrow();
    }
  });

  it("encodes arbitrary raw Shop.domain values into one reversible safe key segment", async () => {
    const bytes = await fixture();
    for (const domain of ["Store.example.org", "store.example.org/path", "user@store.example.org",
      "store.example.org:443", "store..example.org", "store.example.org.", "店.example\n", ""]) {
      const writer = { putVerified: vi.fn(async () => {}) };
      const processor = createShopBrandMediaProcessor({ readConfiguration: async () => configuration,
        fetcher: { fetch: async () => ({ bytes, declaredContentType: "image/png" }) },
        transformer: createShopBrandImageTransformer(), writer, probe: { verify: async () => {} } });
      const result = await processor.process({ ...source, domain });
      expect(result.objectKey.split("/")[1]).toBe(encodeShopBrandDomain(domain));
      expect(result.objectKey.split("/")).toHaveLength(4);
      expect(writer.putVerified).toHaveBeenCalledOnce();
    }
  });
});
