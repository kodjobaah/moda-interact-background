import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { verifyEncodedBrandImage } from "../../../../src/services/shop-brand-media/metadata-verifier.js";
import { createShopBrandR2Writer, type BrandR2Transport } from "../../../../src/services/shop-brand-media/r2-writer.js";
import { createOutreachProductR2Writer } from "../../../../src/services/recovery-product-media/product-r2-writer.js";

const bucket = "public-media-bucket";

async function fixture() {
  const bytes = await sharp({ create: {
    width: 1125, height: 600, channels: 3, background: { r: 255, g: 255, b: 255 },
  } }).jpeg().toBuffer();
  return verifyEncodedBrandImage(bytes, "image/jpeg");
}

describe("product R2 writer", () => {
  it("uses guarded immutable PUT/HEAD and verifies the final product-key metadata", async () => {
    const image = await fixture();
    const objectKey = `outreach-products/shopify/store.example.org/2026/10/31/attempt_1/p-${"a".repeat(64)}/v-none/sha256-${image.contentSha256}.jpg`;
    let exists = false;
    const put = vi.fn(async (input: Record<string, unknown>) => { exists = true; expect(input.IfNoneMatch).toBe("*"); });
    const head = vi.fn(async () => exists ? ({
      ContentType: "image/jpeg", ContentLength: image.sizeBytes,
      Metadata: { sha256: image.contentSha256 }, CacheControl: "public, max-age=31536000, immutable",
    }) : Promise.reject({ $metadata: { httpStatusCode: 404 } }));
    const transport: BrandR2Transport = { head, put };
    await createOutreachProductR2Writer(transport).putVerified({ bucket, objectKey, image });
    expect(put).toHaveBeenCalledTimes(1);
    expect(head).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0]?.[0]).toMatchObject({
      Bucket: bucket, Key: objectKey, ContentType: "image/jpeg", ContentLength: image.sizeBytes,
      CacheControl: "public, max-age=31536000, immutable", Metadata: { sha256: image.contentSha256 },
    });
  });

  it("keeps product and ShopBrand key policies isolated", async () => {
    const image = await fixture();
    const productKey = `outreach-products/shopify/store.example.org/2026/10/31/attempt_1/p-${"a".repeat(64)}/v-none/sha256-${image.contentSha256}.jpg`;
    const brandKey = `shop-brands/store.example.org/logo/sha256-${image.contentSha256}.jpg`;
    const transport: BrandR2Transport = { head: vi.fn(), put: vi.fn() };
    await expect(createShopBrandR2Writer(transport).putVerified({ bucket, objectKey: productKey, image }))
      .rejects.toMatchObject({ code: "OUTPUT_VERIFICATION_FAILED" });
    await expect(createOutreachProductR2Writer(transport).putVerified({ bucket, objectKey: brandKey, image }))
      .rejects.toMatchObject({ code: "OUTPUT_VERIFICATION_FAILED" });
    expect(transport.head).not.toHaveBeenCalled();
    expect(transport.put).not.toHaveBeenCalled();
  });

  it("rejects pre-existing key collisions whose hash metadata differs", async () => {
    const image = await fixture();
    const objectKey = `outreach-products/woocommerce/store.example.org/2026/10/31/attempt_1/p-${"b".repeat(64)}/v-none/sha256-${image.contentSha256}.jpg`;
    const transport: BrandR2Transport = {
      head: vi.fn(async () => ({ ContentType: "image/jpeg", ContentLength: image.sizeBytes,
        Metadata: { sha256: createHash("sha256").update("different").digest("hex") },
        CacheControl: "public, max-age=31536000, immutable" })),
      put: vi.fn(),
    };
    await expect(createOutreachProductR2Writer(transport).putVerified({ bucket, objectKey, image }))
      .rejects.toMatchObject({ code: "R2_OBJECT_MISMATCH" });
    expect(transport.put).not.toHaveBeenCalled();
  });
});
