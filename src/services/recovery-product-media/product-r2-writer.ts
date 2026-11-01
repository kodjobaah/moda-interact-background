import type { VerifiedBrandImage } from "../shop-brand-media/contracts.js";
import type { BrandR2Transport } from "../shop-brand-media/r2-writer.js";
import { putGuardedImmutableR2Object } from "../shop-brand-media/r2-writer.js";
import { isOutreachProductObjectKey } from "./outreach-product-object-key.js";

export type OutreachProductR2Writer = Readonly<{
  putVerified(input: Readonly<{
    bucket: string;
    objectKey: string;
    image: VerifiedBrandImage;
    signal?: AbortSignal;
  }>): Promise<void>;
}>;

/** Product keys are validated independently; ShopBrand continues to accept only shop-brands keys. */
export function createOutreachProductR2Writer(
  transportOrFactory: BrandR2Transport | (() => Promise<BrandR2Transport>),
): OutreachProductR2Writer {
  return {
    putVerified({ bucket, objectKey, image, signal }) {
      return putGuardedImmutableR2Object({
        transportOrFactory,
        bucket,
        objectKey,
        image,
        acceptsKey: (key) => isOutreachProductObjectKey(key) &&
          image.contentType === "image/jpeg" && key.endsWith(`sha256-${image.contentSha256}.jpg`),
        ...(signal ? { signal } : {}),
      });
    },
  };
}
