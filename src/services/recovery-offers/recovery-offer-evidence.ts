import { createHash } from "node:crypto";
import type {
  CheckoutOfferContext, CheckoutRuleEvidence, DiscountOfferCandidate,
  OfferKind, OfferPlatform, VerifiedRecoveryOffer,
} from "./recovery-offer.types.js";

const MAX_EVIDENCE_AGE_MS = 60_000;
const MAX_EVIDENCE_LIFETIME_MS = 60_000;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
}

/** This fingerprint identifies the same immutable input read for evaluation.
 * It is NOT a provider-eligibility proof and must never be used as one. */
export function checkoutOfferFingerprint(checkout: CheckoutOfferContext): string {
  return createHash("sha256").update(canonical({
    id: checkout.id, shopId: checkout.shopId, checkoutToken: checkout.checkoutToken,
    currency: checkout.currency, totalPrice: checkout.totalPrice,
    lineItems: checkout.lineItems, lastExternalActivityAt: checkout.lastExternalActivityAt.toISOString(),
    updatedAt: checkout.updatedAt.toISOString(),
  })).digest("hex");
}

function safeDescription(verifiedValue: string): string | null {
  const value = verifiedValue?.trim();
  if (!value || value.length > 200 || value.includes("{{") || value.includes("}}") ||
      [...value].some((ch) => ((ch.codePointAt(0) ?? 0) < 32 || ch.codePointAt(0) === 127))) return null;
  return value;
}

/** Strictly verify the approved reader's output matches exactly this checkout,
 * provider discount, currency and observation window. An AI suggestion can never
 * provide or override this evidence. */
export function verifiedDecision(input: {
  platform: OfferPlatform;
  shopId: string;
  checkout: CheckoutOfferContext;
  discount: DiscountOfferCandidate;
  kind: OfferKind;
  evidence: CheckoutRuleEvidence;
  now: Date;
  fingerprint: string;
}): VerifiedRecoveryOffer | null {
  const { evidence, checkout, discount, now } = input;
  const evaluated = evidence.evaluatedAt?.getTime();
  const expires = evidence.expiresAt?.getTime();
  const current = now.getTime();
  if (!evidence.qualifies || evidence.shopId !== input.shopId ||
      evidence.checkoutRecoveryId !== checkout.id ||
      evidence.providerDiscountId !== discount.shopifyDiscountNodeId ||
      evidence.checkoutFingerprint !== input.fingerprint ||
      typeof checkout.currency !== "string" || !/^[A-Z]{3}$/.test(checkout.currency) ||
      evidence.currency !== checkout.currency ||
      !Number.isFinite(evaluated) || !Number.isFinite(expires) ||
      evaluated! > current || current - evaluated! > MAX_EVIDENCE_AGE_MS ||
      expires! <= current || expires! - evaluated! > MAX_EVIDENCE_LIFETIME_MS ||
      !Number.isSafeInteger(evidence.savingsMinor) || evidence.savingsMinor <= 0 ||
      !Array.isArray(evidence.verifiedConstraints) || evidence.verifiedConstraints.length > 12 ||
      evidence.verifiedConstraints.some((code) => typeof code !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,63}$/.test(code))) return null;

  const description = safeDescription(evidence.verifiedDescription);
  if (!description || (input.kind === "CODE_OFFER" &&
      evidence.verifiedCode !== discount.singleRedeemCode) ||
      (input.kind === "AUTOMATIC_OFFER" && evidence.verifiedCode !== null)) return null;
  const end = discount.endsAt?.getTime() ?? expires!;
  const expiration = Math.min(expires!, end);
  if (expiration <= current) return null;
  const code = input.kind === "CODE_OFFER" ? discount.singleRedeemCode : null;
  if (input.kind === "CODE_OFFER" && !code) return null;
  return Object.freeze({
    kind: input.kind, shopId: input.shopId, checkoutRecoveryId: checkout.id,
    platform: input.platform, catalogueDiscountId: discount.id,
    providerDiscountId: discount.shopifyDiscountNodeId, description,
    parameters: Object.freeze(code === null ? {} : { code }),
    evidence: Object.freeze({
      source: input.platform === "SHOPIFY" ? "SHOPIFY_CHECKOUT_RULE_READER" as const : "WOO_CHECKOUT_RULE_READER" as const,
      evaluatedAt: new Date(evaluated!), expiresAt: new Date(expiration),
      checkoutFingerprint: input.fingerprint, currency: evidence.currency,
      savingsMinor: evidence.savingsMinor,
    }),
    constraints: Object.freeze([...evidence.verifiedConstraints]),
  });
}

/** Largest proven checkout savings wins; tie goes to stable provider ID, then
 * the internal row ID. Never use model ranking in FIXED mode. */
export function rankVerifiedOffers(offers: readonly VerifiedRecoveryOffer[]): readonly VerifiedRecoveryOffer[] {
  return [...offers].sort((a, b) =>
    b.evidence.savingsMinor - a.evidence.savingsMinor ||
    (a.providerDiscountId < b.providerDiscountId ? -1 : a.providerDiscountId > b.providerDiscountId ? 1 : 0) ||
    (a.catalogueDiscountId < b.catalogueDiscountId ? -1 : a.catalogueDiscountId > b.catalogueDiscountId ? 1 : 0));
}
