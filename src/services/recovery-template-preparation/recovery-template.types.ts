/** ARCH-047 BG001: a local, read-only preparation boundary (not a send permit). */
export type RecoveryStage = "INITIAL" | "FOLLOW_UP";
export type VerifiedOfferPresentation = "NO_OFFER" | "CODE_OFFER" | "AUTOMATIC_OFFER";
export type RecoveryTemplatePurpose =
  | "INITIAL_NO_OFFER" | "INITIAL_CODE_OFFER" | "INITIAL_AUTOMATIC_OFFER"
  | "FOLLOW_UP_NO_OFFER" | "FOLLOW_UP_CODE_OFFER" | "FOLLOW_UP_AUTOMATIC_OFFER";

export type SelectionSource = "exact" | "base" | "merchant-fallback" | "platform-fallback";
export type BrandMediaRole = "logoUrl" | "squareLogoUrl" | "coverImageUrl" | "headerImage";

/** A separate asset-owning architecture must implement this port. No original URLs. */
export type ReadyBrandMedia = Readonly<{
  shopId: string;
  role: BrandMediaRole;
  status: "READY";
  kind: "R2_DERIVATIVE";
  httpsUrl: string;
}>;
export type BrandMediaResolver = (shopId: string, role: BrandMediaRole) =>
  Promise<ReadyBrandMedia | null>;

export type TrustedCheckout = Readonly<{
  shopId: string;
  url: string;
  observedAt: Date;
  expiresAt: Date | null;
  /** Hosts established by the owning, authenticated commerce checkout reader. */
  approvedHosts: readonly string[];
}>;

export type TrustedOffer = Readonly<{
  shopId: string;
  kind: VerifiedOfferPresentation;
  verified: true;
  verifiedAt: Date;
  expiresAt: Date | null;
  code?: string;
  description?: string;
}>;

export type RecoveryTemplatePreparationInput = Readonly<{
  shopId: string;
  /** Must equal the currently configured sender WABA resolved again by this module. */
  senderWabaId: string;
  stage: RecoveryStage;
  offerPresentation: VerifiedOfferPresentation;
  conversationLanguageTag: string | null;
  merchantLanguageTag: string | null;
  platformFallbackEnabled?: boolean;
  platformFallbackLanguageTag?: string | null;
  customerFirstName?: string | null;
  shopName?: Readonly<{ shopId: string; value: string }> | null;
  checkout?: TrustedCheckout | null;
  verifiedOffer?: TrustedOffer | null;
}>;

export type TemplateUnavailableReason =
  | "INVALID_REQUEST" | "INVALID_LANGUAGE" | "SHOP_UNAVAILABLE" | "SENDER_UNAVAILABLE"
  | "SENDER_MISMATCH" | "NO_LANGUAGE" | "NO_APPROVED_ASSIGNMENT"
  | "LEGACY_ASSIGNMENT" | "AMBIGUOUS_ASSIGNMENT" | "REGISTRATION_UNAVAILABLE"
  | "PROVIDER_UNAVAILABLE" | "PROVIDER_DRIFT" | "IDENTITY_MISMATCH"
  | "DEFINITION_UNAVAILABLE" | "LOCALE_UNAVAILABLE" | "BINDINGS_INVALID"
  | "BINDING_FINGERPRINT_MISMATCH" | "BINDING_VALUE_UNAVAILABLE"
  | "CHECKOUT_UNAVAILABLE" | "CHECKOUT_UNTRUSTED" | "MEDIA_NOT_READY";

export type TemplateUnavailable = Readonly<{
  outcome: "unavailable";
  reason: TemplateUnavailableReason;
  purpose: RecoveryTemplatePurpose | null;
}>;

export type TextParameter = Readonly<{ type: "text"; text: string }>;
export type ImageParameter = Readonly<{ type: "image"; image: Readonly<{ link: string }> }>;
export type PreparedMetaComponent =
  | Readonly<{ type: "header"; parameters: readonly (TextParameter | ImageParameter)[] }>
  | Readonly<{ type: "body"; parameters: readonly TextParameter[] }>
  | Readonly<{
      type: "button"; sub_type: "url"; index: string; parameters: readonly [TextParameter];
    }>;

export type PreparedRecoveryTemplate = Readonly<{
  outcome: "prepared";
  shopId: string;
  senderWabaId: string;
  purpose: RecoveryTemplatePurpose;
  canonicalLanguageTag: string;
  selectionSource: SelectionSource;
  variantId: string;
  registrationId: string;
  definitionId: string;
  providerTemplateId: string;
  providerTemplateName: string;
  providerLanguageCode: string;
  /** Original, immutable provider-facing registration digest. */
  submittedContentHash: string;
  /** Verification digest for the frozen compiled projection. */
  bindingFingerprint: string;
  /** Prepared Meta request; never a send/admission permit. */
  template: Readonly<{
    name: string;
    language: Readonly<{ code: string }>;
    components: readonly PreparedMetaComponent[];
  }>;
}>;

export type PreparationResult = PreparedRecoveryTemplate | TemplateUnavailable;

export type RegistrationRow = Readonly<{
  id: string;
  wabaId: string;
  providerTemplateName: string;
  providerLanguageCode: string;
  providerTemplateId: string | null;
  category: string;
  providerStatus: string | null;
  submissionState: string;
  failureCode: string | null;
  lastObservedContentHash: string | null;
  lastObservedCategory: string | null;
  driftDetectedAt: Date | null;
  submittedContentHash: string;
  componentsSnapshot: unknown;
  parameterBindingsSnapshot: unknown;
  locale: Readonly<{
    id: string;
    languageTag: string;
    providerLanguageCode: string | null;
    status: string;
    contentHash: string | null;
    definition: Readonly<{
      id: string;
      kind: string;
      purpose: string | null;
      offerType: string | null;
      status: string;
      category: string | null;
      providerTemplateName: string | null;
      publishedAt: Date | null;
      retiredAt: Date | null;
    }>;
  }>;
}>;

export type AssignedVariantRow = Readonly<{
  id: string;
  shopId: string;
  providerAccountId: string;
  purpose: string;
  languageTag: string;
  providerLanguageCode: string;
  providerTemplateName: string;
  providerTemplateId: string | null;
  status: string;
  enabled: boolean;
  metaRegistrationId: string | null;
  metaRegistration: RegistrationRow | null;
}>;

export type ShopSelectionRow = Readonly<{
  id: string;
  status: string;
  defaultLanguageTag: string | null;
}>;

export type ShopBrandRow = Readonly<{
  brandName: string | null;
  logoUrl: string | null;
  logoAltText: string | null;
  logoWidth: number | null;
  logoHeight: number | null;
  squareLogoUrl: string | null;
  squareLogoAltText: string | null;
  coverImageUrl: string | null;
}>;

export interface RecoveryTemplateRepository {
  readCatalogue(input: { shopId: string; senderWabaId: string; purpose: RecoveryTemplatePurpose }):
    Promise<{ shop: ShopSelectionRow | null; variants: readonly AssignedVariantRow[] }>;
  readShopBrand(shopId: string): Promise<ShopBrandRow | null>;
  /** Resolve only the sending shop's ACTIVE taxonomy-backed Moda category.
   * A non-English language needs an approved/published category translation.
   * Null means the binding is unavailable; never borrow another tenant's category. */
  readShopCategory(shopId: string, languageTag: string): Promise<string | null>;
}
