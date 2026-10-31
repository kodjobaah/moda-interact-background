import { createHash } from "node:crypto";
import type {
  CheckoutPriceReconciliation,
  LinePriceObservation,
} from "./checkout-price-reconciliation.types.js";

const BASKET_FINGERPRINT_PREFIX = "ARCH052_PRICE_BASKET_V1\0";
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DECIMAL_PATTERN = /^[0-9]+(?:\.[0-9]+)?$/;
const currencyExponentCache = new Map<string, number | null>();

type CanonicalLine = Readonly<{
  productId: string | null;
  variantId: string | null;
  title: string | null;
  variantTitle: string | null;
  sku: string | null;
  quantity: number | null;
  price: string | null;
}>;

export type ObservedPriceComparison = Readonly<{
  catalogueComparison: LinePriceObservation["catalogueComparison"];
  reasonCodes: readonly string[];
}>;

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function canonicalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new TypeError(`Invalid basket fingerprint field: ${field}`);
  return value;
}

function canonicalLine(value: unknown): CanonicalLine {
  const item = record(value);
  if (!item) throw new TypeError("Invalid basket fingerprint line item");
  const quantity = item.quantity;
  if (quantity !== undefined && quantity !== null &&
      (typeof quantity !== "number" || !Number.isFinite(quantity))) {
    throw new TypeError("Invalid basket fingerprint field: quantity");
  }
  return {
    productId: canonicalString(item.productId, "productId"),
    variantId: canonicalString(item.variantId, "variantId"),
    title: canonicalString(item.title, "title"),
    variantTitle: canonicalString(item.variantTitle, "variantTitle"),
    sku: canonicalString(item.sku, "sku"),
    quantity: quantity === undefined || quantity === null ? null : quantity,
    price: canonicalString(item.price, "price"),
  };
}

export function fingerprintRecoveryPricingBasket(input: Readonly<{
  shopId: string;
  checkoutRecoveryId: string;
  generation: number;
  currency: string | null;
  lineItems: unknown;
}>): string {
  if (!input || typeof input.shopId !== "string" || input.shopId.length === 0 ||
      typeof input.checkoutRecoveryId !== "string" || input.checkoutRecoveryId.length === 0 ||
      !Number.isSafeInteger(input.generation) || input.generation < 1 ||
      (input.currency !== null && typeof input.currency !== "string")) {
    throw new TypeError("Invalid recovery pricing basket identity");
  }
  const lineItems = Array.isArray(input.lineItems)
    ? input.lineItems.map(canonicalLine)
    : null;
  const canonical = {
    shopId: input.shopId,
    checkoutRecoveryId: input.checkoutRecoveryId,
    generation: input.generation,
    currency: input.currency,
    lineItems,
  };
  return createHash("sha256")
    .update(BASKET_FINGERPRINT_PREFIX + JSON.stringify(canonical), "utf8")
    .digest("hex");
}

function currencyExponent(currency: string): number | null {
  const cached = currencyExponentCache.get(currency);
  if (cached !== undefined) return cached;
  if (!CURRENCY_PATTERN.test(currency)) {
    currencyExponentCache.set(currency, null);
    return null;
  }
  try {
    const supportedCurrencies = Intl.supportedValuesOf("currency");
    if (!supportedCurrencies.includes(currency)) {
      currencyExponentCache.set(currency, null);
      return null;
    }
    const options = new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions();
    const exponent = options.maximumFractionDigits ?? null;
    if (exponent === null || !Number.isInteger(exponent) || exponent < 0 || exponent > 4 ||
      options.minimumFractionDigits !== exponent) {
      currencyExponentCache.set(currency, null);
      return null;
    }
    currencyExponentCache.set(currency, exponent);
    return exponent;
  } catch {
    currencyExponentCache.set(currency, null);
    return null;
  }
}

function minorUnits(value: string, exponent: number): bigint | null {
  if (!DECIMAL_PATTERN.test(value)) return null;
  const [whole = "", fractional = ""] = value.split(".");
  if (fractional.length > exponent) return null;
  const minor = `${whole}${fractional.padEnd(exponent, "0")}`;
  try {
    return BigInt(minor);
  } catch {
    return null;
  }
}

export function compareObservedLinePrices(input: Readonly<{
  checkoutUnitPrice: string | null;
  checkoutCurrency: string | null;
  catalogueUnitPrice: string | null;
  catalogueCurrency: string | null;
}>): ObservedPriceComparison {
  const reasons = new Set<string>(["PRICE_CONTEXT_UNVERIFIED"]);
  const checkoutExponent = input.checkoutCurrency === null
    ? null
    : currencyExponent(input.checkoutCurrency);
  const catalogueExponent = input.catalogueCurrency === null
    ? null
    : currencyExponent(input.catalogueCurrency);
  const checkoutMinor = checkoutExponent === null || input.checkoutUnitPrice === null
    ? null
    : minorUnits(input.checkoutUnitPrice, checkoutExponent);
  const catalogueMinor = catalogueExponent === null || input.catalogueUnitPrice === null
    ? null
    : minorUnits(input.catalogueUnitPrice, catalogueExponent);

  if (input.checkoutUnitPrice !== null && checkoutExponent !== null && checkoutMinor === null) {
    reasons.add("SOURCE_OBSERVATION_INVALID");
  }
  if (input.catalogueUnitPrice !== null && catalogueExponent !== null && catalogueMinor === null) {
    reasons.add("SOURCE_OBSERVATION_INVALID");
  }
  if (checkoutMinor === null) {
    reasons.add("SNAPSHOT_UNIT_PRICE_UNKNOWN");
    if (input.checkoutCurrency !== null && checkoutExponent === null) reasons.add("SOURCE_OBSERVATION_INVALID");
  }
  if (catalogueMinor === null) {
    reasons.add("CATALOGUE_PRICE_UNAVAILABLE");
    if (input.catalogueCurrency !== null && catalogueExponent === null) reasons.add("SOURCE_OBSERVATION_INVALID");
  }
  if (checkoutMinor === null || catalogueMinor === null ||
      input.checkoutCurrency === null || input.catalogueCurrency === null ||
      checkoutExponent === null || catalogueExponent === null) {
    return { catalogueComparison: "INCOMPARABLE", reasonCodes: [...reasons] };
  }
  if (input.checkoutCurrency !== input.catalogueCurrency) {
    reasons.add("CURRENCY_MISMATCH");
    return { catalogueComparison: "INCOMPARABLE", reasonCodes: [...reasons] };
  }
  if (checkoutMinor === catalogueMinor) {
    return { catalogueComparison: "EQUAL", reasonCodes: [...reasons] };
  }
  reasons.add("CATALOGUE_PRICE_DIFFERENCE");
  return { catalogueComparison: "DIFFERENT", reasonCodes: [...reasons] };
}

export function deriveCheckoutPriceReconciliation(input: Readonly<{
  shopId: string;
  checkoutRecoveryId: string;
  outreachAttemptId: string;
  generation: number;
  basketFingerprint: string;
  evaluatedAt: string;
  lines: readonly LinePriceObservation[];
  reasonCodes?: readonly string[];
}>): CheckoutPriceReconciliation {
  const lineReasons = new Set<string>();
  const lines = input.lines.map((line) => {
    const reasonCodes = [...new Set([...line.reasonCodes, "PRICE_CONTEXT_UNVERIFIED"])];
    for (const reason of reasonCodes) lineReasons.add(reason);
    return Object.freeze({
      ...line,
      checkoutPriceChange: "UNVERIFIABLE" as const,
      reasonCodes: Object.freeze(reasonCodes),
    });
  });
  const reasonCodes = [...new Set([...(input.reasonCodes ?? []), ...lineReasons])];
  return Object.freeze({
    shopId: input.shopId,
    checkoutRecoveryId: input.checkoutRecoveryId,
    outreachAttemptId: input.outreachAttemptId,
    generation: input.generation,
    basketFingerprint: input.basketFingerprint,
    evaluatedAt: input.evaluatedAt,
    lines: Object.freeze(lines),
    reasonCodes: Object.freeze(reasonCodes),
    currentMerchandiseSubtotal: null,
    completeness: "PARTIAL",
  });
}