import { createInternationalizationRuntime } from "@modainteract/moda-interact-shared/internationalization";
import type { ModaSupportedLanguageTag } from "@modainteract/moda-interact-shared/internationalization";
import { recommendationMessage } from "./messages.js";
import { formatObservedMoney } from "./money.js";
import { recommendationMessages } from "./messages.js";

export type RenderRecommendationProduct = Readonly<{
  title: string;
  url: string;
  quantity: number;
  scope: "PRODUCT_ONLY" | "ADD_TO_BASKET" | "REPLACE_BASKET_LINE";
  currentPrice: string | null;
  currency: string | null;
  regularPrice?: string | null;
  offerTerms?: readonly Readonly<{ kind: "percent" | "amount" | "free-shipping"; value?: string; currency?: string; code?: string | null; automatic?: boolean }> [];
}>;

export function renderRecommendationReply(input: {
  locale: ModaSupportedLanguageTag;
  disposition: "STANDARD" | "OUT_OF_SCOPE_REDIRECT" | "SHIPPING_INFORMATION_UNVERIFIED";
  storeUrl: string;
  policyUrl?: string | null;
  requiresShipping?: boolean | null;
  products?: readonly RenderRecommendationProduct[];
  includeNoVerifiedOffer?: boolean;
}): string {
  const t = (key: Parameters<typeof recommendationMessage>[1], values?: Record<string, string | number>) =>
    recommendationMessage(input.locale, key, values);
  const lines: string[] = [];
  if (input.disposition === "OUT_OF_SCOPE_REDIRECT") lines.push(t("scopeLimit"));
  if (input.disposition === "SHIPPING_INFORMATION_UNVERIFIED") lines.push(t("shippingUnverified"));
  if (input.requiresShipping !== null && input.requiresShipping !== undefined) {
    lines.push(t(input.requiresShipping ? "shippingRequired" : "shippingNotRequired"));
  }
  if (input.policyUrl) lines.push(t("policyLink", { url: input.policyUrl }));
  for (const product of input.products ?? []) {
    if (product.scope === "ADD_TO_BASKET") lines.push(t("addProposal", { quantity: product.quantity }));
    else if (product.scope === "REPLACE_BASKET_LINE") lines.push(t("replaceProposal", { quantity: product.quantity }));
    else lines.push(t("proposedQuantity", { quantity: product.quantity }));
    lines.push(t("productOption", { title: product.title }));
    if (product.currentPrice && product.currency) {
      const price = formatObservedMoney(product.currentPrice, product.currency,
        // Formatting is provided by the published Shared internationalization runtime.
        (awaitlessRuntime(input.locale)));
      if (price) lines.push(t("currentPrice", { price }));
    }
    if (product.regularPrice && product.currency && product.currentPrice && product.regularPrice !== product.currentPrice) {
      const regular = formatObservedMoney(product.regularPrice, product.currency, awaitlessRuntime(input.locale));
      if (regular) lines.push(t("regularPrice", { price: regular }));
    }
    for (const offer of product.offerTerms ?? []) {
      if (offer.kind === "percent" && offer.value) {
        const raw = Number(offer.value);
        if (Number.isFinite(raw) && raw > 0 && raw <= 100) {
          const percentage = awaitlessRuntime(input.locale).formatPercent(raw / 100);
          lines.push(t("percentTerms", { percentage }));
        }
      }
      else if (offer.kind === "amount" && offer.value && offer.currency) {
        const amount = formatObservedMoney(offer.value, offer.currency, awaitlessRuntime(input.locale));
        if (amount) lines.push(t("amountTerms", { amount }));
      }
      else if (offer.kind === "free-shipping") lines.push(t("freeShippingTerms"));
      if (offer.code) lines.push(t("code", { code: offer.code }));
      if (offer.automatic) lines.push(t("automatic"));
      if (offer.kind !== "free-shipping") lines.push(t("checkoutQualification"));
    }
    lines.push(t("productLink", { url: product.url }));
  }
  if (input.includeNoVerifiedOffer && (input.products?.length ?? 0) > 0) lines.push(t("noVerifiedOffer"));
  if ((input.products?.length ?? 0) === 0 && !input.policyUrl && input.requiresShipping == null) {
    lines.push(t("storeLink", { url: input.storeUrl }));
  }
  return lines.join("\n");
}

function awaitlessRuntime(locale: ModaSupportedLanguageTag) {
  // Constructed per call to keep this module stateless and locale-specific.
  return createRuntime(locale);
}
function createRuntime(locale: ModaSupportedLanguageTag) {
  return createInternationalizationRuntime({ locale, catalogue: recommendationMessages[locale] });
}
