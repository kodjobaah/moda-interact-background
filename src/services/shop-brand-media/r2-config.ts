import { ShopBrandMediaError } from "./contracts.js";

export type ShopBrandR2Credentials = Readonly<{
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}>;

/** Use the validated platform R2 endpoint and credentials; the public-media bucket remains separate. */
export function loadShopBrandR2Credentials(configuration: Readonly<Partial<ShopBrandR2Credentials>>): ShopBrandR2Credentials {
  const { endpoint, accessKeyId, secretAccessKey } = configuration;
  try {
    if (typeof endpoint !== "string" || !endpoint || typeof accessKeyId !== "string" || !accessKeyId ||
        typeof secretAccessKey !== "string" || !secretAccessKey ||
        accessKeyId.trim() !== accessKeyId || secretAccessKey.trim() !== secretAccessKey ||
        /\p{Cc}/u.test(accessKeyId + secretAccessKey) ||
        accessKeyId.length > 256 || secretAccessKey.length > 4096) {
      throw new Error("missing");
    }
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
        parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash ||
        !/^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/.test(parsed.hostname) ||
        endpoint !== parsed.origin && endpoint !== parsed.origin + "/") {
      throw new Error("unsafe-endpoint");
    }
    return Object.freeze({ endpoint: parsed.origin, accessKeyId, secretAccessKey });
  } catch {
    throw new ShopBrandMediaError("R2_CONFIGURATION_INVALID");
  }
}
