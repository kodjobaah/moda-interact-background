import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  createShopBrandMediaProcessor, publicBrandImageUrl,
} from "../../../../src/services/shop-brand-media/processor.js";
import { createShopBrandImageTransformer } from "../../../../src/services/shop-brand-media/image-transformer.js";
import { createShopBrandPublicMediaProbe } from "../../../../src/services/shop-brand-media/public-probe.js";
import { ShopBrandMediaError, type ShopBrandMediaInput } from "../../../../src/services/shop-brand-media/contracts.js";

const configuration = { publicOrigin: "https://shop-brands.modainteract.com",
  bucketName: "moda-interact-shop-brands" };
const source: ShopBrandMediaInput = { shopId: "shop-123", role: "LOGO",
  sourceUrl: "https://merchant.example.org/logo.png?token=should-not-log",
  sourceFingerprint: `sha256:${"a".repeat(64)}`, sourceGeneration: 3 };
const fixture = async () => sharp({ create: { width: 60, height: 30, channels: 3,
  background: "#123456" } }).png().toBuffer();

describe("ARCH-049 media processor / public readiness", () => {
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
      objectKey: expect.stringMatching(/^shop-brands\/shop-123\/logo\/sha256-[a-f0-9]{64}\.jpg$/),
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
      expect.objectContaining({ shopId: source.shopId, role: "LOGO" }));
  });

  it("withholds READY when the public HTTPS domain does not deliver matching image bytes/content type", async () => {
    const bytes = await fixture();
    const image = await createShopBrandImageTransformer().transform(bytes, "LOGO");
    const url = `https://shop-brands.modainteract.com/shop-brands/shop-123/logo/sha256-${image.contentSha256}.jpg`;
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

  it("only builds public origin URLs with validated path keys, never arbitrary external URLs", () => {
    const key = `shop-brands/shop-1/logo/sha256-${"b".repeat(64)}.png`;
    expect(publicBrandImageUrl("https://shop-brands.modainteract.com", key))
      .toBe(`https://shop-brands.modainteract.com/${key}`);
    expect(() => publicBrandImageUrl("http://shop-brands.modainteract.com", key)).toThrow();
    expect(() => publicBrandImageUrl("https://shop-brands.modainteract.com/untrusted", key)).toThrow();
    expect(() => publicBrandImageUrl("https://shop-brands.modainteract.com", "shop-brands/../evil"))
      .toThrow();
  });
});
