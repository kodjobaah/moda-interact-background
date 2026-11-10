import { putGuardedImmutableR2Object, type BrandR2Transport } from "@modainteract/moda-interact-shared/commerce/presentation/node";
export { SHOP_BRAND_CACHE_CONTROL, sanitizeR2ProviderMessage, createBrandR2S3Transport, putGuardedImmutableR2Object, type BrandR2Transport } from "@modainteract/moda-interact-shared/commerce/presentation/node";
import { isShopBrandDomainSegment, type R2ObjectWriter, type VerifiedBrandImage } from "./contracts.js";

function isShopBrandObjectKey(objectKey: string, image: VerifiedBrandImage): boolean {
  const [prefix, domain, role, filename] = objectKey.split("/");
  return prefix === "shop-brands" && isShopBrandDomainSegment(domain) &&
    ["logo", "square_logo", "cover_image"].includes(role ?? "") &&
    /^sha256-[a-f0-9]{64}\.(jpg|png)$/.test(filename ?? "") && objectKey.split("/").length === 4 &&
    (image.contentType === "image/jpeg" ? objectKey.endsWith(".jpg") : objectKey.endsWith(".png"));
}

export function createShopBrandR2Writer(
  transportOrFactory: BrandR2Transport | (() => Promise<BrandR2Transport>),
): R2ObjectWriter {
  return {
    putVerified({ bucket, objectKey, image }) {
      return putGuardedImmutableR2Object({
        transportOrFactory, bucket, objectKey, image,
        acceptsKey: (key) => isShopBrandObjectKey(key, image),
      });
    },
  };
}
