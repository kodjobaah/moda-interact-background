import { ShopBrandMediaError } from "./contracts.js";

export type ShopBrandR2Credentials = Readonly<{
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}>;

/** Dedicated public-brand R2 credentials. Never use Merchant Knowledge secrets or bucket. */
export function loadShopBrandR2Credentials(environment: Readonly<NodeJS.ProcessEnv>): ShopBrandR2Credentials {
  const endpoint = environment.SHOPBRAND_R2_ENDPOINT;
  const accessKeyId = environment.SHOPBRAND_R2_ACCESS_KEY_ID;
  const secretAccessKey = environment.SHOPBRAND_R2_SECRET_ACCESS_KEY;
  try {
    if (!endpoint || !accessKeyId || !secretAccessKey ||
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
