import { createHash } from "node:crypto";
import { ShopBrandMediaError, boundedMediaProviderMessage, type PublicMediaProbe, type SafeFetcher } from "./contracts.js";

/** A HEAD-only check is insufficient: GET the current custom domain and match the stored bytes. */
export function createShopBrandPublicMediaProbe(fetcher: SafeFetcher): PublicMediaProbe {
  return {
    async verify({ url, image }, signal) {
      try {
        const result = await fetcher.fetch(url, signal);
        if (result.declaredContentType !== image.contentType ||
            result.bytes.length !== image.sizeBytes ||
            createHash("sha256").update(result.bytes).digest("hex") !== image.contentSha256) {
          throw new ShopBrandMediaError("PUBLIC_MEDIA_MISMATCH", true);
        }
      } catch (error) {
        if (error instanceof ShopBrandMediaError && error.code === "PUBLIC_MEDIA_MISMATCH") throw error;
        // Always withhold READY metadata when the custom domain cannot deliver the new object.
        throw new ShopBrandMediaError("PUBLIC_MEDIA_UNAVAILABLE", true,
          (error instanceof ShopBrandMediaError ? error.providerMessage : undefined) ??
            boundedMediaProviderMessage(error));
      }
    },
  };
}
