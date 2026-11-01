import type { RecoveryPolicySnapshot } from "../recovery-policy.service.js";

export type OfferStage = "INITIAL" | "FOLLOW_UP";
export type OfferPlatform = "SHOPIFY" | "WOOCOMMERCE";
export type OfferKind = "CODE_OFFER" | "AUTOMATIC_OFFER";

/** The configured FIXED id is an internal catalogue row, never a coupon code. */
export type RecoveryOfferPolicy = Readonly<Pick<
  RecoveryPolicySnapshot, "recoveryOfferMode" | "fixedShopifyDiscountId" | "offerSnapshot"
> & {
  /** Optional additional ids only when obtained from a trusted merchant-policy reader. */
  authorisedDiscountIds?: readonly string[];
}>;

/** Obtained from a durable record of what sequence 1 *actually sent*, not from the
 * mutable merchant selection or an outreach policy snapshot. */
export type PreviouslyPromisedOffer = Readonly<
  | { kind: "NO_OFFER" }
  | { kind: OfferKind; providerDiscountId: string; code?: string;
      promotionTarget?: "CHECKOUT" | "ALTERNATIVE_PRODUCT" }
>;

export type ResolveRecoveryOfferInput = Readonly<{
  shopId: string;
  checkoutRecoveryId: string;
  stage: OfferStage;
  policy: RecoveryOfferPolicy;
  now: Date;
  previouslyPromisedOffer?: PreviouslyPromisedOffer | null;
}>;

export type NoOfferReason =
  | "POLICY_NONE" | "INVALID_CONTEXT" | "RECOVERY_UNAVAILABLE" | "STALE_CHECKOUT"
  | "PREVIOUS_OFFER_UNKNOWN" | "PREVIOUS_OFFER_UNAVAILABLE"
  | "NO_AUTHORISED_DISCOUNTS" | "CATALOGUE_UNAVAILABLE" | "CANDIDATE_UNAVAILABLE"
  | "CANDIDATE_LIMIT" | "PROVIDER_VERIFICATION_UNAVAILABLE" | "NO_ELIGIBLE_DISCOUNTS"
  | "AI_UNAVAILABLE" | "AI_INCONCLUSIVE";

export type NoRecoveryOffer = Readonly<{ kind: "NO_OFFER"; reason: NoOfferReason }>;
export type VerifiedRecoveryOffer = Readonly<{
  kind: OfferKind;
  shopId: string;
  checkoutRecoveryId: string;
  platform: OfferPlatform;
  catalogueDiscountId: string;
  providerDiscountId: string;
  description: string;
  parameters: Readonly<{ code?: string }>;
  evidence: Readonly<{
    source: "SHOPIFY_CHECKOUT_RULE_READER" | "WOO_CHECKOUT_RULE_READER";
    evaluatedAt: Date;
    expiresAt: Date;
    checkoutFingerprint: string;
    currency: string;
    savingsMinor: number;
  }>;
  constraints: readonly string[];
}>;
export type RecoveryOfferDecision = NoRecoveryOffer | VerifiedRecoveryOffer;

export type CheckoutOfferContext = Readonly<{
  id: string;
  shopId: string;
  checkoutToken: string;
  status: string;
  currency: string | null;
  totalPrice: string | null;
  lineItems: unknown;
  lastExternalActivityAt: Date;
  updatedAt: Date;
}>;
export type ShopOfferContext = Readonly<{ id: string; status: string; platform: string }>;
export type CatalogueOfferContext = Readonly<{
  shopId: string; status: string; lastSuccessfulSyncAt: Date | null; unavailableAt: Date | null;
}>;
export type DiscountOfferCandidate = Readonly<{
  id: string;
  shopId: string;
  shopifyDiscountNodeId: string;
  providerType: string;
  method: string;
  providerStatus: string;
  title: string;
  summary: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  codeCount: number | null;
  singleRedeemCode: string | null;
  fixedSelectable: boolean;
  isAvailable: boolean;
  unavailableAt: Date | null;
  providerSnapshot: unknown;
}>;

/** Persisted checkout/discount facts are necessary for candidate discovery but
 * are never proof that the provider will apply a discount to this checkout. */
export interface RecoveryOfferRepository {
  readShop(shopId: string): Promise<ShopOfferContext | null>;
  readCheckout(shopId: string, checkoutRecoveryId: string): Promise<CheckoutOfferContext | null>;
  readCatalogue(shopId: string): Promise<CatalogueOfferContext | null>;
  readDiscounts(shopId: string, ids: readonly string[] | null, limit: number): Promise<readonly DiscountOfferCandidate[]>;
}

export type CheckoutRuleEvidence = Readonly<{
  shopId: string;
  checkoutRecoveryId: string;
  providerDiscountId: string;
  checkoutFingerprint: string;
  evaluatedAt: Date;
  expiresAt: Date;
  currency: string;
  savingsMinor: number;
  /** Confirmed against current provider state, not copied from the catalogue. */
  verifiedCode: string | null;
  verifiedDescription: string;
  qualifies: true;
  /** These codes describe already-verified restrictions; no user-facing text. */
  verifiedConstraints: readonly string[];
}>;

export type ProviderEligibilityResult =
  | Readonly<{ outcome: "eligible"; evidence: CheckoutRuleEvidence }>
  | Readonly<{ outcome: "ineligible" | "unavailable" }>;

/** Approved provider/Commerce implementation must independently read current
 * checkout, discount rules and restrictions. In particular it may not use a
 * merchant-side catalogue snapshot as final eligibility evidence. */
export interface ReadOnlyProviderEligibility {
  evaluate(input: Readonly<{
    shopId: string;
    checkout: CheckoutOfferContext;
    checkoutFingerprint: string;
    discount: DiscountOfferCandidate;
    now: Date;
    signal: AbortSignal;
  }>): Promise<ProviderEligibilityResult>;
}

/** Model output is only a catalogue ID recommendation. Never an eligibility
 * verdict, untrusted discount description, code, or raw checkout mutation. */
export interface ReadOnlyOfferRecommender {
  recommend(input: Readonly<{
    shopId: string;
    checkoutRecoveryId: string;
    currency: string;
    choices: readonly Readonly<{ catalogueDiscountId: string; savingsMinor: number; kind: OfferKind }>[];
    /** Approved model adapter must enforce this output-token ceiling. */
    maxOutputTokens: 32;
    signal: AbortSignal;
  }>): Promise<string | null>;
}

export interface RecoveryOfferReporter {
  warn(event: string, data: Record<string, unknown>): void;
  error(event: string, data: Record<string, unknown>): void;
}
