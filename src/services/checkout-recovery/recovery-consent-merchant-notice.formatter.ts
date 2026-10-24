import { createHash } from "node:crypto";
import type {
  RecoveryConsentBlockedOperation,
  RecoveryConsentNoticeInput,
  RecoveryConsentNoticePlatform,
  RecoveryConsentNoticeReason,
} from "./recovery-consent-merchant-notice.contracts.js";

const reasonCopy: Record<RecoveryConsentNoticeReason, string> = {
  NO_VERIFIED_OPT_IN: "Verified WhatsApp marketing permission is not available for this customer.",
  RECIPIENT_UNVERIFIED: "Moda could not verify the exact customer and WhatsApp recipient for this checkout.",
  RECIPIENT_AMBIGUOUS: "Moda could not identify one unambiguous WhatsApp recipient for this checkout.",
  VERIFICATION_UNAVAILABLE:
    "WhatsApp consent verification was temporarily unavailable. The customer's preference is unknown, not refused.",
};
const operationCopy: Record<RecoveryConsentBlockedOperation, string> = {
  CREATE_FIRST_RECOVERY: "No checkout recovery was created, and no WhatsApp recovery message was sent.",
  SEND_INITIAL_RECOVERY: "The initial WhatsApp recovery message was not sent at this check. An existing recovery may remain.",
};
const platformCopy: Record<RecoveryConsentNoticePlatform, string> = {
  SHOPIFY: "Shopify",
  WOOCOMMERCE: "WooCommerce",
};

/** Validation failures contain field names only, never checkout/customer values. */
export function validateRecoveryConsentNoticeInput(input: RecoveryConsentNoticeInput): void {
  if (!input || typeof input !== "object") throw new TypeError("Invalid recovery consent notice input");
  if (typeof input.shopId !== "string" || !input.shopId.trim() || Array.from(input.shopId).length > 128) {
    throw new TypeError("Invalid shopId");
  }
  if (typeof input.checkoutToken !== "string" || !input.checkoutToken.trim() ||
      Array.from(input.checkoutToken).length > 1024) {
    throw new TypeError("Invalid checkoutToken");
  }
  if (!Object.hasOwn(platformCopy, input.platform)) throw new TypeError("Invalid platform");
  if (!Object.hasOwn(reasonCopy, input.reason)) throw new TypeError("Invalid reason");
  if (!Object.hasOwn(operationCopy, input.blockedOperation)) throw new TypeError("Invalid blockedOperation");
}

/** Pre-production canonical identity shared by Shopify and WooCommerce adapters. */
export function createRecoveryConsentNoticeSourceKey(input: RecoveryConsentNoticeInput): string {
  validateRecoveryConsentNoticeInput(input);
  const payload = JSON.stringify([
    "recovery-consent", 1, input.platform, input.shopId, input.checkoutToken,
    input.blockedOperation, input.reason,
  ]);
  return `recovery-consent:v1:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

function containsPrivateToken(value: string, checkoutToken: string): boolean {
  // Checkout tokens are normally long opaque strings. Avoid treating a one-letter
  // fixture token as a substring of every customer name.
  return value === checkoutToken || (checkoutToken.length >= 8 && value.includes(checkoutToken));
}

function nameLine(value: unknown, checkoutToken: string): string | undefined {
  if (typeof value !== "string") return;
  // One plain-text line: keep separating whitespace, discard control/bidi and HTML delimiters.
  const plain = value
    .replace(/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069<>]/gu, " ")
    .replace(/\s+/gu, " ").trim();
  if (!plain || /(?:https?:\/\/|www\.)/i.test(plain) ||
      /(?:\+?\d[\s.()/-]*){9,}/u.test(plain) || containsPrivateToken(plain, checkoutToken)) return;
  return Array.from(plain).slice(0, 120).join("").trim() || undefined;
}

function emailLine(value: unknown, checkoutToken: string): string | undefined {
  if (typeof value !== "string") return;
  const email = value.trim();
  if (!email || email.length > 254 || /[\s\p{Cc}\p{Cf}<>]/u.test(email) ||
      containsPrivateToken(email, checkoutToken)) return;
  const parts = email.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return;
  return email;
}

function totalLine(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return;
  const amount = (value as { amountDecimal?: unknown }).amountDecimal;
  const currency = (value as { currency?: unknown }).currency;
  if (typeof amount !== "string" || typeof currency !== "string" ||
      !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,3})?$/.test(amount) || !/^[A-Z]{3}$/.test(currency)) return;
  return `${currency} ${amount}`;
}

function activityLine(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  // Validate the literal calendar date too: Date.parse normalises 30 February.
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|([+-])(\d\d):(\d\d))$/.exec(value);
  if (!match) return;
  const [, y, m, d, hh, mm, ss, , , oh, om] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const hour = Number(hh);
  const minute = Number(mm);
  const second = Number(ss);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if (day < 1 || day > daysInMonth) return;
  if (oh !== undefined && om !== undefined &&
      (Number(oh) > 14 || Number(om) > 59 || (Number(oh) === 14 && Number(om) !== 0))) return;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return;
  return `${parsed.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function referenceLine(value: unknown, checkoutToken: string): string | undefined {
  if (typeof value !== "string") return;
  const reference = value.trim();
  if (reference.length > 80 || !/^[A-Za-z0-9#][A-Za-z0-9 ._#/-]{0,79}$/.test(reference)) return;
  if (reference.toLowerCase() === checkoutToken.trim().toLowerCase() || /^www\./i.test(reference) || /^https?\b/i.test(reference) ||
      /^(?:[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})$/i.test(reference) ||
      /(?:^|[ ._/#-])(?:session|cart|checkout)[-_ ]?token(?:$|[ ._/#-])/i.test(reference)) return;
  const tokenHash = createHash("sha256").update(checkoutToken).digest("hex");
  if (reference.toLowerCase() === tokenHash || containsPrivateToken(reference, checkoutToken)) return;
  return reference;
}

/** Fixed-order plain-text Support copy, with no lookups or side effects. */
export function formatRecoveryConsentMerchantNotice(input: RecoveryConsentNoticeInput): string {
  validateRecoveryConsentNoticeInput(input);
  const context = input.context;
  const optional: string[] = [];
  const name = nameLine(context?.customerName, input.checkoutToken);
  if (name) optional.push(`Customer: ${name}`);
  const email = emailLine(context?.customerEmail, input.checkoutToken);
  if (email) optional.push(`Email: ${email}`);
  const total = totalLine(context?.checkoutTotal);
  if (total) optional.push(`Checkout total: ${total}`);
  if (typeof context?.itemCount === "number" && Number.isSafeInteger(context.itemCount) &&
      context.itemCount >= 0 && context.itemCount <= 100000) {
    optional.push(`Items: ${context.itemCount}`);
  }
  const activity = activityLine(context?.lastActivityAt);
  if (activity) optional.push(`Last recorded activity: ${activity}`);
  const reference = referenceLine(context?.merchantVisibleReference, input.checkoutToken);
  if (reference) optional.push(`Checkout reference: ${reference}`);

  function render() {
    return [
      "Checkout recovery could not proceed",
      `Platform: ${platformCopy[input.platform]}`,
      ...(optional.length ? optional : ["Customer / checkout details: Not available from the recorded checkout."]),
      `Reason: ${reasonCopy[input.reason]}`,
      `Outcome: ${operationCopy[input.blockedOperation]}`,
    ].join("\n");
  }
  let body = render();
  // Even 254 Unicode email code units + 120 name code points must never
  // exceed the Support message's UTF-8 limit; omit optional presentation only.
  while (Buffer.byteLength(body, "utf8") > 2048 && optional.length) {
    optional.splice(optional.findIndex((line) => line.length === Math.max(...optional.map((x) => x.length))), 1);
    body = render();
  }
  if (Buffer.byteLength(body, "utf8") > 2048) throw new Error("Recovery consent notice body exceeds limit");
  return body;
}
