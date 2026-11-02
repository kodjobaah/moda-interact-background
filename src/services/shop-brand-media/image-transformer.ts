import sharp from "sharp";
import {
  SHOP_BRAND_CANVAS, SHOP_BRAND_MAX_INPUT_PIXELS, SHOP_BRAND_MAX_OUTPUT_BYTES,
  SHOP_BRAND_TARGET_OUTPUT_BYTES, ShopBrandMediaError,
  type ImageTransformer, type ShopBrandImageRole, type ShopBrandImageMime,
} from "./contracts.js";
import { verifyEncodedBrandImage } from "./metadata-verifier.js";

const SUPPORTED_SOURCES = new Set(["jpeg", "png", "webp", "avif", "heif", "gif", "svg", "tiff"]);

/** Deny SVG constructs capable of loading secondary, unpinned network/file resources. */
export function assertSelfContainedSvg(bytes: Buffer): void {
  const markup = bytes.toString("utf8");
  if (/(?:<!DOCTYPE|<!ENTITY|<\s*(?:script|image|use|foreignObject|iframe|object|embed|style|feImage)\b|(?:xlink:)?href\s*=|url\s*\(|@import\b|\bon[a-z]+\s*=)/i.test(markup)) {
    throw new ShopBrandMediaError("INVALID_IMAGE");
  }
}

/** Sharp/libvips is the sole decoder; metadata is a hint, not proof of source MIME. */
export function createShopBrandImageTransformer(): ImageTransformer {
  return {
    async transform(bytes: Buffer, role: ShopBrandImageRole) {
      if (!Buffer.isBuffer(bytes) || !bytes.length || !(["LOGO", "SQUARE_LOGO", "COVER_IMAGE"] as const).includes(role)) {
        throw new ShopBrandMediaError("INVALID_IMAGE");
      }
      let mime: ShopBrandImageMime;
      let output: Buffer | undefined;
      try {
        // Reject dangerous XML references before even allowing librsvg to inspect metadata.
        if (bytes.subarray(0, 512).toString("utf8").replace(/^\uFEFF/, "").trimStart().startsWith("<")) {
          assertSelfContainedSvg(bytes);
        }
        const source = sharp(bytes, { limitInputPixels: SHOP_BRAND_MAX_INPUT_PIXELS,
          failOn: "error", animated: false, pages: 1 });
        const info = await source.metadata();
        if (!info.format || !SUPPORTED_SOURCES.has(info.format) || !info.width || !info.height) {
          throw new ShopBrandMediaError("INVALID_IMAGE");
        }
        if (info.format === "svg") assertSelfContainedSvg(bytes);
        if (info.width * info.height > SHOP_BRAND_MAX_INPUT_PIXELS) {
          throw new ShopBrandMediaError("INPUT_PIXELS_EXCEEDED");
        }
        const transparent = Boolean(info.hasAlpha);
        mime = transparent ? "image/png" : "image/jpeg";
        const build = () => {
          const image = sharp(bytes, { limitInputPixels: SHOP_BRAND_MAX_INPUT_PIXELS,
            failOn: "error", animated: false, pages: 1 })
            .rotate()
            .toColourspace("srgb")
            .resize(SHOP_BRAND_CANVAS.width, SHOP_BRAND_CANVAS.height, {
              fit: role === "COVER_IMAGE" ? "cover" : "contain",
              position: "centre",
              background: transparent
                ? { r: 255, g: 255, b: 255, alpha: 0 }
                : { r: 255, g: 255, b: 255, alpha: 1 },
              withoutEnlargement: false,
            });
          return transparent ? image : image.flatten({ background: "#ffffff" }).removeAlpha();
        };
        if (transparent) {
          output = await build().png({ compressionLevel: 9, palette: false }).toBuffer();
          // Quantise only when necessary to meet the provider cap; keep alpha semantics.
          if (output.length > SHOP_BRAND_TARGET_OUTPUT_BYTES) {
            const compact = await build().png({ compressionLevel: 9, palette: true,
              quality: 100, dither: 0 }).toBuffer();
            if (compact.length < output.length &&
                (compact.length <= SHOP_BRAND_TARGET_OUTPUT_BYTES ||
                 output.length >= SHOP_BRAND_MAX_OUTPUT_BYTES)) output = compact;
          }
        } else {
          for (const quality of [86, 76, 66, 56, 46]) {
            const encoded = await build().jpeg({ quality, mozjpeg: true,
              chromaSubsampling: "4:2:0" }).toBuffer();
            if (!output || encoded.length < output.length) output = encoded;
            if (encoded.length <= SHOP_BRAND_TARGET_OUTPUT_BYTES) break;
          }
        }
      } catch (error) {
        if (error instanceof ShopBrandMediaError) throw error;
        // libvips and codec exceptions may include paths or byte excerpts: never propagate them.
        throw new ShopBrandMediaError("INVALID_IMAGE");
      }
      if (!output || output.length >= SHOP_BRAND_MAX_OUTPUT_BYTES) {
        throw new ShopBrandMediaError("OUTPUT_TOO_LARGE");
      }
      return verifyEncodedBrandImage(output, mime);
    },
  };
}
