import { createHash } from "node:crypto";
import {
  decryptCredential,
  parseCredentialKeyring,
  type CredentialEnvelope,
} from "@modainteract/moda-interact-shared/security/credentials/node";
import { parseShopifyCustomerIdentity } from "@modainteract/moda-interact-shared/identity";
import type { ShopifyConsentReceiptAttribute } from "../domain/abandoned-checkout.js";

export type ShopifyConsentReceiptVerification =
  | { status: "NO_EXPLICIT_CHOICE" }
  | { status: "INVALID_OR_AMBIGUOUS_RECEIPT" }
  | { status: "DEFER_CHECKOUT_BINDING" }
  | { status: "DEFER_IDENTITY_OR_RECIPIENT" }
  | {
      status: "VERIFIED";
      decision: "GRANTED" | "REVOKED";
      acceptedAt: number;
      customerId: string;
      locale: string;
      kind: "c" | "x";
    };

type ReceiptClaims = [
  1,
  string,
  "c" | "x",
  string,
  "G" | "R",
  "1",
  string,
  number,
  string,
];

const SHOP_ID_PATTERN = /^[a-z0-9]{20,40}$/;
const CUSTOMER_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const LOCALE_PATTERN = /^[A-Za-z0-9-]{2,35}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RECEIPT_ATTRIBUTE_MAX_BYTES = 512;

export function verifyShopifyConsentReceipt(input: {
  attribute: ShopifyConsentReceiptAttribute;
  shopId: string;
  shopifyPlus: boolean | null;
  cartToken: string | null;
  checkoutToken: string;
  verifiedShopifyCustomerId: string | null;
  keyringJson?: string;
  now?: Date;
}): ShopifyConsentReceiptVerification {
  if (input.attribute.kind === "MISSING") return { status: "NO_EXPLICIT_CHOICE" };
  if (input.attribute.kind === "INVALID" || !SHOP_ID_PATTERN.test(input.shopId)) {
    return { status: "INVALID_OR_AMBIGUOUS_RECEIPT" };
  }
  if (input.shopifyPlus === null) return { status: "INVALID_OR_AMBIGUOUS_RECEIPT" };

  const kind = input.shopifyPlus ? "x" : "c";
  const bindingToken = kind === "c"
    ? input.cartToken?.split("?", 1)[0]?.trim()
    : input.checkoutToken.trim();
  if (!bindingToken) return { status: "DEFER_CHECKOUT_BINDING" };
  const bindingDigest = createHash("sha256")
    .update(bindingToken, "utf8")
    .digest("base64url");
  if (!SHA256_BASE64URL_PATTERN.test(bindingDigest)) {
    return { status: "DEFER_CHECKOUT_BINDING" };
  }

  const serialized = input.attribute.value;
  if (Buffer.byteLength(serialized, "utf8") > RECEIPT_ATTRIBUTE_MAX_BYTES ||
      !/^[\x21-\x7e]+$/.test(serialized)) {
    return { status: "INVALID_OR_AMBIGUOUS_RECEIPT" };
  }
  const fields = serialized.split(".");
  if (fields.length !== 5 || fields[0] !== "v1" ||
      !KEY_ID_PATTERN.test(fields[1] ?? "") ||
      !isCanonicalBase64Url(fields[2] ?? "") ||
      !isCanonicalBase64Url(fields[3] ?? "") ||
      !isCanonicalBase64Url(fields[4] ?? "")) {
    return { status: "INVALID_OR_AMBIGUOUS_RECEIPT" };
  }
  const nonce = Buffer.from(fields[2]!, "base64url");
  const ciphertext = Buffer.from(fields[3]!, "base64url");
  const authTag = Buffer.from(fields[4]!, "base64url");
  if (nonce.length !== 12 || ciphertext.length === 0 || authTag.length !== 16) {
    return { status: "INVALID_OR_AMBIGUOUS_RECEIPT" };
  }

  let plaintext: string;
  try {
    const keyring = parseCredentialKeyring(input.keyringJson);
    const envelope: CredentialEnvelope = {
      keyId: fields[1]!,
      nonce: Uint8Array.from(nonce),
      ciphertext: Uint8Array.from(ciphertext),
      authTag: Uint8Array.from(authTag),
    };
    const aad = JSON.stringify([
      "moda-shopify-wa-consent",
      1,
      input.shopId,
      kind,
      bindingDigest,
    ]);
    plaintext = decryptCredential({ keyring, envelope, aad });
  } catch {
    return { status: "INVALID_OR_AMBIGUOUS_RECEIPT" };
  }

  let claims: unknown;
  try {
    claims = JSON.parse(plaintext);
  } catch {
    return { status: "INVALID_OR_AMBIGUOUS_RECEIPT" };
  }
  if (!Array.isArray(claims) || claims.length !== 9 ||
      JSON.stringify(claims) !== plaintext) {
    return { status: "INVALID_OR_AMBIGUOUS_RECEIPT" };
  }
  const value = claims as ReceiptClaims;
  const [version, shopId, claimKind, claimDigest, decision, disclosure, locale, acceptedAt, customerId] = value;
  if (version !== 1 || shopId !== input.shopId || claimKind !== kind ||
      claimDigest !== bindingDigest || (decision !== "G" && decision !== "R") ||
      disclosure !== "1" || typeof locale !== "string" ||
      !LOCALE_PATTERN.test(locale) || !isCanonicalLocale(locale) ||
      typeof acceptedAt !== "number" || !Number.isSafeInteger(acceptedAt) ||
      acceptedAt <= 0 ||
      acceptedAt > Math.floor((input.now ?? new Date()).getTime() / 1000) + 300 ||
      typeof customerId !== "string" ||
      (customerId !== "-" && !CUSTOMER_ID_PATTERN.test(customerId))) {
    return { status: "INVALID_OR_AMBIGUOUS_RECEIPT" };
  }

  if (customerId === "-") {
    if (input.verifiedShopifyCustomerId !== null) {
      return { status: "DEFER_IDENTITY_OR_RECIPIENT" };
    }
  } else {
    if (!input.verifiedShopifyCustomerId) return { status: "DEFER_IDENTITY_OR_RECIPIENT" };
    try {
      const verifiedIdentity = parseShopifyCustomerIdentity(input.verifiedShopifyCustomerId);
      if (verifiedIdentity.numericId !== customerId) {
        return { status: "DEFER_IDENTITY_OR_RECIPIENT" };
      }
    } catch {
      return { status: "DEFER_IDENTITY_OR_RECIPIENT" };
    }
  }

  return {
    status: "VERIFIED",
    decision: decision === "G" ? "GRANTED" : "REVOKED",
    acceptedAt,
    customerId,
    locale,
    kind,
  };
}

function isCanonicalBase64Url(value: string): boolean {
  return value.length > 0 &&
    /^[A-Za-z0-9_-]+$/.test(value) &&
    Buffer.from(value, "base64url").toString("base64url") === value;
}

function isCanonicalLocale(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value)[0] === value;
  } catch {
    return false;
  }
}
