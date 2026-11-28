import { createHash } from "node:crypto";
import { isInitialRetryId } from "../../domain/recovery-outreach-identity.js";

/** Match the existing platform-specific unique provider permits exactly. */
export function expectedInitialRetryDispatchKey(
  platform: string,
  shopId: string,
  attemptId: string,
): string | null {
  if (!isInitialRetryId(attemptId)) return null;
  if (platform === "SHOPIFY")
    return `recovery-retry-${createHash("sha256").update(attemptId).digest("hex")}`;
  if (platform === "WOOCOMMERCE")
    return `arch046-woo-initial-${createHash("sha256").update(shopId).update("\0").update(attemptId).digest("hex")}`;
  return null;
}
