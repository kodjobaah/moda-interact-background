import { commerceStoreHostname } from "@modainteract/moda-interact-shared/commerce";
import type { PreparedWrapper, VerifiedWrapperContext, WrapperRefusal, WrapperSource } from "./contracts.js";
import { appendRecoveryCheckoutFooter, RECOVERY_CHECKOUT_DIVIDER } from "./recovery-checkout-footer.js";
import { MAX_WHATSAPP_TEXT_LENGTH } from "./render.js";

/** Local database-attested identity; never a provider grant or a caller's tenant authority. */
export type RecoveryShopHeaderReceipt = Readonly<{schemaVersion: 1; shopId: string; name: string | null; websiteUrl: string}>;

export function verifiedShopWebsite(domain: string): string | null {
  if (domain.replace(/^https:\/\//, "").split("/")[0]?.includes(":")) return null;
  const host = commerceStoreHostname(domain);
  return host && host.includes(".") && !host.endsWith(".invalid") ? `https://${host}` : null;
}

function safeHeaderName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  // Identity is a single plain-text line. Unsafe/oversized names use domain-only fallback.
  // eslint-disable-next-line no-control-regex
  return name && name.length <= 512 && !/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069`<>[\]]/.test(name) ? name : null;
}

export function verifiedRecoveryShopHeader(shopId: string, domain: string, name: unknown): RecoveryShopHeaderReceipt | null {
  const websiteUrl = verifiedShopWebsite(domain);
  return websiteUrl ? {schemaVersion: 1, shopId, name: safeHeaderName(name), websiteUrl} : null;
}

export function readRecoveryShopHeader(value: unknown): RecoveryShopHeaderReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 4 || row.schemaVersion !== 1 || typeof row.shopId !== "string" || !row.shopId || row.shopId.length > 128 ||
      typeof row.websiteUrl !== "string" || verifiedShopWebsite(row.websiteUrl) !== row.websiteUrl ||
      row.name !== null && (typeof row.name !== "string" || safeHeaderName(row.name) !== row.name)) return null;
  return {schemaVersion: 1, shopId: row.shopId, name: row.name as string | null, websiteUrl: row.websiteUrl};
}

export function recoveryShopHeaderPrefix(receipt: RecoveryShopHeaderReceipt): string {
  return [...(receipt.name ? [receipt.name] : []), receipt.websiteUrl, RECOVERY_CHECKOUT_DIVIDER].join("\n") + "\n\n";
}

export function withRecoveryShopHeader(body: string, receipt: RecoveryShopHeaderReceipt): string {
  const prefix = recoveryShopHeaderPrefix(receipt);
  return body.startsWith(prefix) ? body : prefix + body;
}

export function hasPreparedRecoveryShopHeader(body: string, receipt: unknown): receipt is RecoveryShopHeaderReceipt {
  const parsed = readRecoveryShopHeader(receipt);
  return parsed !== null && body.startsWith(recoveryShopHeaderPrefix(parsed));
}

/** Deduplicate only the known configured wrapper header, not authored response text. */
function withoutPureIdentityWrapperHeader(body: string, receipt: RecoveryShopHeaderReceipt,
  prepared: PreparedWrapper | undefined, context: VerifiedWrapperContext): string {
  if (!prepared?.header.length) return body;
  const parts: string[] = [];
  for (const token of prepared.header) {
    if (token.kind === "text") parts.push(token.value);
    else if (token.kind === "variable" && ["shop.name", "shopBrand.brandName"].includes(token.name)) {
      const value = context.variables[token.name];
      if (!value) return body;
      parts.push(value);
    } else return body;
  }
  const header = parts.join("");
  const identityOnly = header.split("\n").map(line => line.trim()).filter(Boolean)
    .every(line => line === receipt.name || line === receipt.websiteUrl || line === RECOVERY_CHECKOUT_DIVIDER);
  return identityOnly && header && body.startsWith(header + "\n") ? body.slice(header.length + 1) : body;
}

/** All decoration precedes immutable preparation, media selection, moderation and permit. */
export function prepareRecoveryReplyBody(input: {body: string; source: WrapperSource; context: VerifiedWrapperContext; prepared?: PreparedWrapper}):
  {kind: "ready"; body: string; recoveryCheckoutUrl?: string; recoveryShopHeader?: RecoveryShopHeaderReceipt} |
  {kind: "rejected"; reason: WrapperRefusal} {
  const raw = input.context.recoveryShopHeader;
  const header = raw === undefined ? null : readRecoveryShopHeader(raw);
  if (raw !== undefined && (!header || header.shopId !== input.context.shopId)) return {kind: "rejected", reason: "TENANT_MISMATCH"};
  const body = header ? withoutPureIdentityWrapperHeader(input.body, header, input.prepared, input.context) : input.body;
  const footer = appendRecoveryCheckoutFooter({...input, body});
  if (footer.kind === "rejected") return footer;
  const complete = header ? withRecoveryShopHeader(footer.body, header) : footer.body;
  if (complete.length > MAX_WHATSAPP_TEXT_LENGTH) return {kind: "rejected", reason: "OUTPUT_TOO_LONG"};
  return {...footer, body: complete, ...(header ? {recoveryShopHeader: header} : {})};
}
