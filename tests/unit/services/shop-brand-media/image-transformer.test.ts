import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createShopBrandImageTransformer } from "../../../../src/services/shop-brand-media/image-transformer.js";
import { verifyEncodedBrandImage } from "../../../../src/services/shop-brand-media/metadata-verifier.js";

const processor = createShopBrandImageTransformer();
const canvas = { width: 1125, height: 600 };

describe("ARCH-049 ShopBrand image normaliser", () => {
  it("pads an opaque logo without distortion, with a white canvas", async () => {
    const source = await sharp({ create: { width: 80, height: 80, channels: 3,
      background: { r: 255, g: 0, b: 0 } } }).jpeg().toBuffer();
    const result = await processor.transform(source, "LOGO");
    expect(result).toMatchObject({ contentType: "image/jpeg", ...canvas });
    expect(result.sizeBytes).toBeLessThan(5 * 1024 * 1024);
    expect(result.contentSha256).toBe(createHash("sha256").update(result.bytes).digest("hex"));
    const raw = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true });
    const pixelAt = (x: number, y: number) => [...raw.data.subarray((y * canvas.width + x) * 3, (y * canvas.width + x) * 3 + 3)];
    expect(pixelAt(10, 300)).toEqual([255, 255, 255]);
    expect(pixelAt(562, 300)[0]).toBeGreaterThan(200);
    expect(pixelAt(562, 300)[1]).toBeLessThan(40);
  });

  it("preserves PNG transparency during square logo padding and strips input metadata", async () => {
    const input = await sharp({ create: { width: 400, height: 100, channels: 4,
      background: { r: 0, g: 128, b: 255, alpha: 0.5 } } }).png().toBuffer();
    const result = await processor.transform(input, "SQUARE_LOGO");
    expect(result).toMatchObject({ contentType: "image/png", ...canvas });
    const raw = await sharp(result.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixelAt = (x: number, y: number) => [...raw.data.subarray((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4)];
    expect(pixelAt(10, 10)[3]).toBe(0);
    expect(pixelAt(562, 300)[3]).toBeGreaterThan(0);
    expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();
    expect(await verifyEncodedBrandImage(result.bytes, "image/png")).toEqual(result);
  });

  it("centre-crops a wide cover rather than stretching it", async () => {
    const stripes = Buffer.alloc(300 * 100 * 3);
    for (let y = 0; y < 100; y++) for (let x = 0; x < 300; x++) {
      const offset = (y * 300 + x) * 3;
      stripes[offset] = x < 100 ? 255 : 0;
      stripes[offset + 1] = x >= 100 && x < 200 ? 255 : 0;
      stripes[offset + 2] = x >= 200 ? 255 : 0;
    }
    const source = await sharp(stripes, { raw: { width: 300, height: 100, channels: 3 } }).png().toBuffer();
    const result = await processor.transform(source, "COVER_IMAGE");
    expect(result).toMatchObject({ contentType: "image/jpeg", ...canvas });
    const raw = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true });
    const centre = (300 * canvas.width + 562) * 3;
    expect(raw.data[centre + 1]).toBeGreaterThan(160);
    expect(raw.data[centre]).toBeLessThan(60);
    expect(raw.data[centre + 2]).toBeLessThan(60);
  });

  it("strips EXIF from a real metadata-bearing JPEG source", async () => {
    const input = await sharp({ create: { width: 150, height: 100, channels: 3,
      background: "teal" } }).jpeg().withExif({ IFD0: { Artist: "customer-private-data" } }).toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const result = await processor.transform(input, "LOGO");
    const output = await sharp(result.bytes).metadata();
    expect(output.exif).toBeUndefined();
    expect(output.xmp).toBeUndefined();
    expect(output.iptc).toBeUndefined();
  });

  it("accepts a WebP source but only publishes JPEG/PNG", async () => {
    const source = await sharp({ create: { width: 25, height: 20, channels: 3,
      background: "orange" } }).webp().toBuffer();
    expect((await processor.transform(source, "LOGO")).contentType).toBe("image/jpeg");
  });

  it("rejects SVG images with external file/network references (bypass DNS pinning)", async () => {
    const linkedSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><image href="http://169.254.169.254/latest/meta-data/" width="100" height="100"/></svg>');
    await expect(processor.transform(linkedSvg, "LOGO"))
      .rejects.toMatchObject({ code: "INVALID_IMAGE" });
    const inlineSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="blue"/></svg>');
    expect((await processor.transform(inlineSvg, "LOGO")).contentType).toMatch(/^image\/(jpeg|png)$/);
  });

  it("rejects decompression bombs and corrupt/non-image payloads", async () => {
    const hugeSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="25000" height="25000"><rect width="100%" height="100%"/></svg>');
    await expect(processor.transform(hugeSvg, "LOGO")).rejects.toMatchObject({
      code: expect.stringMatching(/INPUT_PIXELS_EXCEEDED|INVALID_IMAGE/),
    });
    await expect(processor.transform(Buffer.from("<script>not an image</script>"), "LOGO"))
      .rejects.toMatchObject({ code: "INVALID_IMAGE" });
  });

  it("rejects mismatched output content type even if it has a .png extension", async () => {
    const jpeg = await sharp({ create: { width: 1125, height: 600, channels: 3,
      background: "white" } }).jpeg().toBuffer();
    await expect(verifyEncodedBrandImage(jpeg, "image/png"))
      .rejects.toMatchObject({ code: "OUTPUT_VERIFICATION_FAILED" });
  });
});
