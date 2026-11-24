import { createHash } from "node:crypto";
import {
  decryptCredential,
  parseCredentialKeyring,
  type CredentialEnvelope,
} from "@modainteract/moda-interact-shared/security/credentials/node";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { parseShopifyCustomerIdentity } from "@modainteract/moda-interact-shared/identity";
import type { ShopifyConsentReceiptAttribute } from "../domain/abandoned-checkout.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";

export type ShopifyConsentReceiptVerification =
  | { status: "NO_EXPLICIT_CHOICE" }
  | { status: "INVALID_OR_AMBIGUOUS_RECEIPT" }
  | {
      status: "KEYRING_CONFIGURATION_FAILURE";
      reason: "KEYRING_MISSING" | "KEYRING_INVALID";
      cause?: unknown;
    }
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
const verifierLogger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

export function verifyShopifyConsentReceipt(input: {
  attribute: ShopifyConsentReceiptAttribute;
  shopId: string;
  shopifyPlus: boolean | null;
  cartToken: string | null;
  checkoutToken: string;
  verifiedShopifyCustomerId: string | null;
  keyringJson?: string;
  now?: Date;
  logger?: Pick<StructuredLogger, "info" | "warn" | "error">;
}): ShopifyConsentReceiptVerification {
  const logger = input.logger ?? verifierLogger;
  const checkoutCorrelation = createHash("sha256")
    .update(input.checkoutToken)
    .digest("hex")
    .slice(0, 16);
  const logContext = {
    shopId: input.shopId,
    checkoutCorrelation,
    operation: "verify_checkout_consent_receipt",
    stage: "receipt_verification",
  };
  if (input.attribute.kind === "MISSING") return { status: "NO_EXPLICIT_CHOICE" };
  if (input.attribute.kind === "INVALID" || !SHOP_ID_PATTERN.test(input.shopId)) {
    logger.warn("shopify.consent.receipt.decrypt_rejected", {
      ...logContext,
      outcome: "invalid",
      reasonCode: input.attribute.kind === "INVALID" ? "ATTRIBUTE_INVALID" : "SHOP_ID_INVALID",
      message: "Consent attribute or authenticated shop identity failed validation.",
    });
    return { status: "INVALID_OR_AMBIGUOUS_RECEIPT" };
  }
  if (input.shopifyPlus === null) {
    logger.warn("shopify.consent.receipt.decrypt_rejected", {
      ...logContext,
      outcome: "invalid",
      reasonCode: "SHOP_PLAN_UNAVAILABLE",
      message: "Shop plan could not be verified for consent receipt validation.",
    });
    return { status: "INVALID_OR_AMBIGUOUS_RECEIPT" };
  }

  const kind = input.shopifyPlus ? "x" : "c";
  const bindingToken = kind === "c"
    ? input.cartToken?.split("?", 1)[0]?.trim()
    : input.checkoutToken.trim();
  if (!bindingToken) {
    logger.info("shopify.consent.receipt.identity_deferred", {
      ...logContext,
      outcome: "deferred",
      reasonCode: "TRUSTED_CHECKOUT_BINDING_MISSING",
      message: "Consent receipt was not evaluated because the authenticated checkout binding is missing.",
    });
    return { status: "DEFER_CHECKOUT_BINDING" };
  }
  const bindingDigest = createHash("sha256")
    .update(bindingToken, "utf8")
    .digest("base64url");
  if (!SHA256_BASE64URL_PATTERN.test(bindingDigest)) {
    return { status: "DEFER_CHECKOUT_BINDING" };
  }

  const serialized = input.attribute.value;
  if (Buffer.byteLength(serialized, "utf8") > RECEIPT_ATTRIBUTE_MAX_BYTES ||
      !/^[\x21-\x7e]+$/.test(serialized)) {
    logger.warn("shopify.consent.receipt.decrypt_rejected", {
      ...logContext,
      outcome: "invalid",
      reasonCode: "ENVELOPE_FORMAT_INVALID",
      message: "Consent receipt envelope is overlong or contains non-ASCII characters.",
    });
    return { status: "INVALID_OR_AMBIGUOUS_RECEIPT" };
  }
  const fields = serialized.split(".");
  if (fields.length !== 5 || fields[0] !== "v1" ||
      !KEY_ID_PATTERN.test(fields[1] ?? "") ||
      !isCanonicalBase64Url(fields[2] ?? "") ||
      !isCanonicalBase64Url(fields[3] ?? "") ||
      !isCanonicalBase64Url(fields[4] ?? "")) {
    logger.warn("shopify.consent.receipt.decrypt_rejected", {
      ...logContext,
      outcome: "invalid",
      reasonCode: "ENVELOPE_FORMAT_INVALID",
      message: "Consent receipt envelope does not match the canonical v1 format.",
    });
    return { status: "INVALID_OR_AMBIGUOUS_RECEIPT" };
  }
  const nonce = Buffer.from(fields[2]!, "base64url");
  const ciphertext = Buffer.from(fields[3]!, "base64url");
  const authTag = Buffer.from(fields[4]!, "base64url");
  if (nonce.length !== 12 || ciphertext.length === 0 || authTag.length !== 16) {
    logger.warn("shopify.consent.receipt.decrypt_rejected", {
      ...logContext,
      outcome: "invalid",
      reasonCode: "ENVELOPE_LENGTH_INVALID",
      message: "Consent receipt nonce, ciphertext, or authentication tag length is invalid.",
    });
    return { status: "INVALID_OR_AMBIGUOUS_RECEIPT" };
  }

  if (!input.keyringJson) {
    const error = new Error("MODA_ENCRYPTION_KEYS_JSON is not configured");
    logger.error("shopify.consent.receipt.keyring_missing", {
      ...logContext,
      outcome: "operational_failure",
      reasonCode: "KEYRING_MISSING",
      error,
    });
    return { status: "KEYRING_CONFIGURATION_FAILURE", reason: "KEYRING_MISSING", cause: error };
  }

  let keyring: ReturnType<typeof parseCredentialKeyring>;
  try {
    keyring = parseCredentialKeyring(input.keyringJson);
  } catch (error) {
    logger.error("shopify.consent.receipt.keyring_invalid", {
      ...logContext,
      outcome: "operational_failure",
      reasonCode: "KEYRING_INVALID",
      error,
    });
    return { status: "KEYRING_CONFIGURATION_FAILURE", reason: "KEYRING_INVALID", cause: error };
  }

  let plaintext: string;
  try {
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
  } catch (error) {
    logger.warn("shopify.consent.receipt.decrypt_rejected", {
      ...logContext,
      outcome: "invalid",
      reasonCode: "RECEIPT_DECRYPT_REJECTED",
      error,
    });
    return { status: "INVALID_OR_AMBIGUOUS_RECEIPT" };
  }

  let claims: unknown;
  try {
    claims = JSON.parse(plaintext);
  } catch (error) {
    logger.warn("shopify.consent.receipt.claim_parse_failed", {
      ...logContext,
      outcome: "invalid",
      reasonCode: "CLAIM_JSON_INVALID",
      error,
    });
    return { status: "INVALID_OR_AMBIGUOUS_RECEIPT" };
  }
  if (!Array.isArray(claims) || claims.length !== 9 ||
      JSON.stringify(claims) !== plaintext) {
    logger.warn("shopify.consent.receipt.claim_invalid", {
      ...logContext,
      outcome: "invalid",
      reasonCode: "CLAIM_SHAPE_INVALID",
      message: "Authenticated receipt claims are not the exact nine-member v1 JSON array.",
    });
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
    logger.warn("shopify.consent.receipt.claim_invalid", {
      ...logContext,
      outcome: "invalid",
      reasonCode: "CLAIM_VALUE_INVALID",
      message: "Authenticated receipt claims failed v1 value validation.",
    });
    return { status: "INVALID_OR_AMBIGUOUS_RECEIPT" };
  }

  // Guest consent remains bound to the authenticated checkout, even when
  // Shopify associates a customer account after the guest's selection.
  if (customerId !== "-") {
    if (!input.verifiedShopifyCustomerId) {
      logger.info("shopify.consent.receipt.identity_deferred", {
        ...logContext,
        outcome: "deferred",
        reasonCode: "VERIFIED_CUSTOMER_MISSING",
        message: "Signed customer identity cannot be matched because Shopify returned no verified customer.",
      });
      return { status: "DEFER_IDENTITY_OR_RECIPIENT" };
    }
    try {
      const verifiedIdentity = parseShopifyCustomerIdentity(input.verifiedShopifyCustomerId);
      if (verifiedIdentity.numericId !== customerId) {
        logger.info("shopify.consent.receipt.identity_deferred", {
          ...logContext,
          outcome: "deferred",
          reasonCode: "SIGNED_CUSTOMER_MISMATCH",
          message: "Signed receipt customer does not match the verified Shopify customer.",
        });
        return { status: "DEFER_IDENTITY_OR_RECIPIENT" };
      }
    } catch (error) {
      logger.info("shopify.consent.receipt.identity_deferred", {
        ...logContext,
        outcome: "deferred",
        reasonCode: "VERIFIED_CUSTOMER_ID_INVALID",
        error,
      });
      return { status: "DEFER_IDENTITY_OR_RECIPIENT" };
    }
  }

  const verified = {
    status: "VERIFIED",
    decision: decision === "G" ? "GRANTED" : "REVOKED",
    acceptedAt,
    customerId,
    locale,
    kind,
  } as const;
  logger.info("shopify.consent.receipt.verified", {
    ...logContext,
    outcome: "verified",
    decision: verified.decision,
    reasonCode: "SIGNED_RECEIPT_VALID",
  });
  return verified;
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
