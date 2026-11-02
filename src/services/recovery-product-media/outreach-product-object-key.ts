import { createHash } from "node:crypto";
import { isOutreachMerchantSiteSegment } from "./merchant-site-segment.js";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f;
  });
}

export type OutreachProductObjectKeyInput = Readonly<{
  platform: "SHOPIFY" | "WOOCOMMERCE";
  merchantSite: string;
  preparedAt: Date;
  outreachAttemptId: string;
  providerProductId: string;
  providerVariantId: string | null;
  contentSha256: string;
}>;

function invalid(): never { throw new TypeError("OUTREACH_PRODUCT_OBJECT_KEY_INVALID"); }
function identityHash(platform: string, id: string): string {
  return createHash("sha256").update(`${platform.toLowerCase()}\0${id}`, "utf8").digest("hex");
}

/** Pure immutable key construction from already trusted source identity and final JPEG hash. */
export function buildOutreachProductObjectKey(input: OutreachProductObjectKeyInput): string {
  if (!input || !["SHOPIFY", "WOOCOMMERCE"].includes(input.platform) ||
      !isOutreachMerchantSiteSegment(input.merchantSite) ||
      !(input.preparedAt instanceof Date) || !Number.isFinite(input.preparedAt.getTime()) ||
      input.preparedAt.getUTCFullYear() < 0 || input.preparedAt.getUTCFullYear() > 9999 ||
      !ID.test(input.outreachAttemptId) || typeof input.providerProductId !== "string" ||
      !input.providerProductId.trim() || input.providerProductId.length > 512 ||
      hasControlCharacters(input.providerProductId) ||
      (input.providerVariantId !== null && (typeof input.providerVariantId !== "string" ||
        !input.providerVariantId.trim() || input.providerVariantId.length > 512 ||
        hasControlCharacters(input.providerVariantId))) ||
      !SHA256.test(input.contentSha256)) return invalid();

  const platform = input.platform.toLowerCase();
  const year = String(input.preparedAt.getUTCFullYear()).padStart(4, "0");
  const month = String(input.preparedAt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(input.preparedAt.getUTCDate()).padStart(2, "0");
  const product = identityHash(input.platform, input.providerProductId);
  const variant = input.providerVariantId === null ? "none" : identityHash(input.platform, input.providerVariantId);
  const key = `outreach-products/${platform}/${input.merchantSite}/${year}/${month}/${day}/${input.outreachAttemptId}/p-${product}/v-${variant}/sha256-${input.contentSha256}.jpg`;
  return Buffer.byteLength(key, "utf8") <= 1024 ? key : invalid();
}

/** Independent strict key guard; product keys never enter the ShopBrand key validator. */
export function isOutreachProductObjectKey(value: string): boolean {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1024) return false;
  const parts = value.split("/");
  if (parts.length !== 10 || parts[0] !== "outreach-products" ||
      !["shopify", "woocommerce"].includes(parts[1] ?? "") ||
      !isOutreachMerchantSiteSegment(parts[2] ?? "") ||
      !/^\d{4}$/.test(parts[3] ?? "") || !/^\d{2}$/.test(parts[4] ?? "") ||
      !/^\d{2}$/.test(parts[5] ?? "") || !ID.test(parts[6] ?? "") ||
      !/^p-[a-f0-9]{64}$/.test(parts[7] ?? "") ||
      !/^v-(?:none|[a-f0-9]{64})$/.test(parts[8] ?? "") ||
      !/^sha256-[a-f0-9]{64}\.jpg$/.test(parts[9] ?? "")) return false;
  const [year, month, day] = [Number(parts[3]), Number(parts[4]), Number(parts[5])];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
