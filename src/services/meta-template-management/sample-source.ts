import { readShopBrandPublicMediaConfiguration } from "../platform-configuration/consumers.js";
import { createSafeImageFetcher } from "../shop-brand-media/safe-fetch.js";
import { MetaManagementError } from "./contracts.js";
import { META_TEMPLATE_SAMPLE_ASSET, validateMetaTemplateSample } from "./sample-asset.js";
export interface MetaTemplateSampleSource { read(signal?: AbortSignal): Promise<{ bytes: Buffer; declaredContentType: "image/jpeg" }> }
export function metaTemplateSampleUrl(origin: string): string {
  try {
    const base = new URL(origin);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/" || base.port) throw new Error();
    const url = new URL(META_TEMPLATE_SAMPLE_ASSET.objectKey, base);
    if (url.origin !== base.origin) throw new Error();
    return url.href;
  } catch { throw new MetaManagementError("META_SAMPLE_CONFIGURATION_INVALID", "blocked"); }
}
export function createProductionMetaTemplateSampleSource(options: {
  readConfiguration?: typeof readShopBrandPublicMediaConfiguration;
  fetcher?: Pick<ReturnType<typeof createSafeImageFetcher>, "fetch">;
} = {}): MetaTemplateSampleSource {
  const fetcher = options.fetcher ?? createSafeImageFetcher({ maxBytes: 5_000_000, maxRedirects: 0 });
  return { async read(signal) {
    let config;
    try { config = await (options.readConfiguration ?? readShopBrandPublicMediaConfiguration)(); }
    catch { throw new MetaManagementError("META_SAMPLE_CONFIGURATION_UNAVAILABLE", "uncertain"); }
    const result = await fetcher.fetch(metaTemplateSampleUrl(config.publicOrigin), signal);
    validateMetaTemplateSample(result.bytes, result.declaredContentType);
    return { bytes: result.bytes, declaredContentType: "image/jpeg" };
  } };
}
