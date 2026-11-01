import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createOutreachProductImageTransformer } from "../../../../src/services/recovery-product-media/product-image-transformer.js";

describe("createOutreachProductImageTransformer", () => {
  it("produces a centered, white-padded, single-frame 1125x600 metadata-free JPEG", async () => {
    const source = await sharp({
      create: { width: 100, height: 300, channels: 4, background: { r: 220, g: 10, b: 20, alpha: 0.5 } },
    }).png().toBuffer();
    const result = await createOutreachProductImageTransformer().transform(source);
    const decoded = sharp(result.bytes);
    const metadata = await decoded.metadata();
    expect(result.contentType).toBe("image/jpeg");
    expect(result.width).toBe(1125);
    expect(result.height).toBe(600);
    expect(result.sizeBytes).toBeLessThan(5 * 1024 * 1024);
    expect(result.bytes.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(metadata).toMatchObject({ format: "jpeg", width: 1125, height: 600 });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.iptc).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    const { data, info } = await decoded.raw().toBuffer({ resolveWithObject: true });
    const left = data.subarray(0, info.channels);
    expect([...left.slice(0, 3)]).toEqual([255, 255, 255]);
  });

  it("rejects oversized decoded sources and external SVG references", async () => {
    const oversized = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8000" height="6000"></svg>');
    await expect(createOutreachProductImageTransformer().transform(oversized))
      .rejects.toMatchObject({ code: "INPUT_PIXELS_EXCEEDED" });
    const unsafeSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="https://attacker.test/a"/></svg>');
    await expect(createOutreachProductImageTransformer().transform(unsafeSvg))
      .rejects.toMatchObject({ code: "INVALID_IMAGE" });
  });
});
