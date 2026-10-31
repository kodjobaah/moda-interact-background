import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { isPublicIpAddress } from "../merchant-knowledge-network-policy.js";

export type WooRecoveryLinkOmissionReason =
  | "RESTORE_SNAPSHOT_ABSENT"
  | "RESTORE_SNAPSHOT_UNSUPPORTED"
  | "CANONICAL_SITE_INVALID"
  | "SHOP_DOMAIN_INVALID"
  | "SHOP_HOST_MISMATCH";

export type WooRecoveryLinkPlan = Readonly<{
  kind: "ready";
  canonicalSiteUrl: string;
  shopDomain: string;
}> | Readonly<{
  kind: "omitted";
  reason: WooRecoveryLinkOmissionReason;
}>;

function parseShopDomain(value: string): URL | null {
  try {
    const url = new URL(URL.canParse(value) ? value : `https://${value}`);
    if (!url.hostname || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host.endsWith(".")) return false;
  const family = isIP(host);
  if (family !== 0) return isPublicIpAddress(host);
  if (!host.includes(".")) return false;
  if (host === "localhost" || [".localhost", ".local", ".test", ".invalid", ".example", ".internal", ".intranet", ".lan", ".home", ".home.arpa"].some((suffix) => host.endsWith(suffix))) {
    return false;
  }
  return true;
}

/**
 * Validate the verified merchant origin before a database transaction begins.
 * DNS and HTTP are intentionally absent: URL issuance never contacts merchant.
 */
export function prepareWooRecoveryLink(
  canonicalSiteUrl: string,
  shopDomain: string,
): WooRecoveryLinkPlan {
  let site: URL;
  try {
    site = new URL(canonicalSiteUrl);
  } catch {
    return { kind: "omitted", reason: "CANONICAL_SITE_INVALID" };
  }
  const canonicalPath = site.pathname.replace(/\/+$/, "");
  const canonicalWithoutSlash = `${site.origin}${canonicalPath}`;
  const isCanonical = canonicalSiteUrl === canonicalWithoutSlash || canonicalSiteUrl === `${canonicalWithoutSlash}/`;
  if (Buffer.byteLength(canonicalSiteUrl, "utf8") > 512 || site.protocol !== "https:" ||
      site.username || site.password || site.search || site.hash || !isPublicHostname(site.hostname) || !isCanonical) {
    return { kind: "omitted", reason: "CANONICAL_SITE_INVALID" };
  }

  const domain = parseShopDomain(shopDomain);
  if (!domain || !isPublicHostname(domain.hostname)) {
    return { kind: "omitted", reason: "SHOP_DOMAIN_INVALID" };
  }
  if (domain.hostname.toLowerCase() !== site.hostname.toLowerCase()) {
    return { kind: "omitted", reason: "SHOP_HOST_MISMATCH" };
  }

  return { kind: "ready", canonicalSiteUrl, shopDomain };
}

/** Called only after the admission transaction has ruled out an existing row. */
export function generateWooRecoveryToken(): string {
  // 32 random bytes encode to exactly 43 unpadded base64url characters.
  return randomBytes(32).toString("base64url");
}

/** Preserve a merchant home subpath while using its directory as the landing path. */
export function buildWooRecoveryUrl(
  plan: Extract<WooRecoveryLinkPlan, { kind: "ready" }>,
  recoveryId: string,
  token: string,
): string {
  const canonical = new URL(plan.canonicalSiteUrl);
  const basePath = canonical.pathname.replace(/\/+$/, "");
  const url = new URL(`${basePath}/`, canonical.origin);
  url.searchParams.set("moda_interact_resume", "1");
  url.searchParams.set("r", recoveryId);
  url.searchParams.set("t", token);
  return url.href;
}
