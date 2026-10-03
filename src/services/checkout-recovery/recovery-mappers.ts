import type { RecoveryCheckoutSeed } from "../../events/checkout-events.js";
import type { NormalizedAbandonedCheckout } from "../../domain/abandoned-checkout.js";
import type { PendingRecoveryCandidate } from "../../domain/pending-recovery-candidate.js";
import {
  canonicaliseLanguageTag,
  normalizeCountryCode,
  normalizeTimeZone,
  type InternationalContext,
} from "@modainteract/moda-interact-shared/internationalization";

type MerchantInternationalDefaults = {
  defaultLanguageTag: string | null;
  defaultCountryCode: string | null;
  defaultTimeZone: string | null;
};

export function resolveRecoveryInternationalContext(
  candidate: PendingRecoveryCandidate,
  checkout: NormalizedAbandonedCheckout,
  merchantDefaults: MerchantInternationalDefaults | null | undefined,
): InternationalContext {
  const eventContext = candidate.internationalContext;
  const currentContext = checkout.internationalContext ?? {
    languageTag: null,
    languageSource: null,
    countryCode: null,
    currencyCode: null,
    timeZone: null,
  };
  const languageTag = safelyNormalize(
    merchantDefaults?.defaultLanguageTag,
    canonicaliseLanguageTag,
  );

  return {
    languageTag,
    languageSource: languageTag ? "merchant-default" : null,
    countryCode:
      currentContext.countryCode ??
      eventContext?.countryCode ??
      safelyNormalize(merchantDefaults?.defaultCountryCode, normalizeCountryCode),
    currencyCode: currentContext.currencyCode ?? eventContext?.currencyCode ?? null,
    timeZone:
      currentContext.timeZone ??
      eventContext?.timeZone ??
      safelyNormalize(merchantDefaults?.defaultTimeZone, normalizeTimeZone),
  };
}

export function toRecoverySeed(
  candidate: PendingRecoveryCandidate,
  shopDomain: string,
  checkout: NormalizedAbandonedCheckout,
  internationalContext: InternationalContext,
): RecoveryCheckoutSeed {
  return {
    shop: shopDomain,
    checkoutToken: candidate.checkoutToken,
    cartToken: candidate.cartToken,
    detectedAt:
      checkout.createdAt ||
      candidate.checkoutCreatedAt ||
      new Date().toISOString(),
    ...(candidate.lastActivityAt
      ? { lastExternalActivityAt: candidate.lastActivityAt }
      : {}),
    currency: checkout.currencyCode,
    totalPrice: checkout.totalPrice,
    checkoutUrl: checkout.abandonedCheckoutUrl,
    completedAt: checkout.completedAt,
    internationalContext,
    customer: checkout.customer
      ? {
          shopifyCustomerId: checkout.customer.shopifyCustomerId,
          phone: checkout.customer.phone,
          email: checkout.customer.email,
          firstName: checkout.customer.firstName,
          lastName: checkout.customer.lastName,
        }
      : {
          shopifyCustomerId: null,
          phone: null,
          email: null,
          firstName: null,
          lastName: null,
        },
    lineItems: serializeRecoveryLineItems(checkout.lineItems),
  };
}

export function serializeRecoveryLineItems(
  lineItems: NormalizedAbandonedCheckout["lineItems"],
): RecoveryCheckoutSeed["lineItems"] {
  return lineItems.map((lineItem) => ({
    productId: lineItem.productId,
    variantId: lineItem.variantId,
    title: lineItem.title,
    variantTitle: lineItem.variantTitle,
    sku: lineItem.sku,
    quantity: lineItem.quantity,
    price: lineItem.price,
  }));
}

function safelyNormalize(
  value: string | null | undefined,
  normalizer: (value: string) => string,
): string | null {
  if (!value?.trim()) return null;

  try {
    return normalizer(value);
  } catch {
    return null;
  }
}