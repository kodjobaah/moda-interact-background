import { canonicaliseLanguageTag } from "@modainteract/moda-interact-shared/internationalization";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type {
  AssignedVariantRow,
  RecoveryStage,
  SelectionSource,
  ShopSelectionRow,
  TemplateUnavailableReason,
  VerifiedOfferPresentation,
} from "./recovery-template.types.js";

export const PURPOSE_BY_STAGE_AND_OFFER = {
  INITIAL: {
    NO_OFFER: "INITIAL_NO_OFFER",
    CODE_OFFER: "INITIAL_CODE_OFFER",
    AUTOMATIC_OFFER: "INITIAL_AUTOMATIC_OFFER",
  },
  FOLLOW_UP: {
    NO_OFFER: "FOLLOW_UP_NO_OFFER",
    CODE_OFFER: "FOLLOW_UP_CODE_OFFER",
    AUTOMATIC_OFFER: "FOLLOW_UP_AUTOMATIC_OFFER",
  },
} as const;

export function purposeFor(stage: RecoveryStage, offer: VerifiedOfferPresentation) {
  return PURPOSE_BY_STAGE_AND_OFFER[stage][offer];
}

function language(value: string | null | undefined, logger: Pick<StructuredLogger, "warn">,
  source: string): string | null {
  if (value == null || value.trim() === "") return null;
  try {
    return canonicaliseLanguageTag(value);
  } catch (error) {
    logger.warn("recovery_template.language_validation_rejected", {
      source,
      errorType: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}

export type SelectedAssignment = Readonly<{
  variant: AssignedVariantRow;
  canonicalLanguageTag: string;
  selectionSource: SelectionSource;
}>;

export type AssignmentSelection =
  | { outcome: "selected"; value: SelectedAssignment }
  | { outcome: "unavailable"; reason: TemplateUnavailableReason };

/** Selection is pure except for bounded diagnostics on caught parsing errors. */
export function selectRecoveryAssignment(input: {
  shop: ShopSelectionRow;
  shopId: string;
  senderWabaId: string;
  purpose: string;
  variants: readonly AssignedVariantRow[];
  stage: RecoveryStage;
  offer: VerifiedOfferPresentation;
  conversationLanguageTag: string | null;
  merchantLanguageTag: string | null;
  platformFallbackEnabled: boolean;
  platformFallbackLanguageTag: string | null;
  logger: Pick<StructuredLogger, "warn">;
}): AssignmentSelection {
  const customer = language(input.conversationLanguageTag, input.logger, "conversation");
  const merchant = language(input.shop.defaultLanguageTag, input.logger, "stored-merchant-default");
  const passedMerchant = language(input.merchantLanguageTag, input.logger, "merchant-context");
  const platform = language(input.platformFallbackLanguageTag, input.logger, "platform-fallback");
  if ((input.conversationLanguageTag && !customer) ||
      (input.merchantLanguageTag && !passedMerchant) ||
      (input.shop.defaultLanguageTag && !merchant) ||
      (input.platformFallbackEnabled && input.platformFallbackLanguageTag && !platform) ||
      (passedMerchant && passedMerchant !== merchant)) {
    return { outcome: "unavailable", reason: "INVALID_LANGUAGE" };
  }

  // Defence in depth: these checks also protect tests and alternate repository
  // adapters; no caller-injected row may cross the authenticated shop/WABA slot.
  if (input.shop.id !== input.shopId || input.variants.some((row) =>
      row.shopId !== input.shopId || row.providerAccountId !== input.senderWabaId ||
      row.purpose !== input.purpose || row.status !== "APPROVED" || row.enabled !== true)) {
    return { outcome: "unavailable", reason: "IDENTITY_MISMATCH" };
  }

  const choices: Array<{ tag: string; source: SelectionSource }> = [];
  const add = (tag: string | null, source: SelectionSource) => {
    if (tag && !choices.some((choice) => choice.tag === tag)) choices.push({ tag, source });
  };
  add(customer, "exact");
  if (customer) add(new Intl.Locale(customer).language, "base");
  add(merchant, "merchant-fallback");
  if (input.platformFallbackEnabled) add(platform, "platform-fallback");
  if (!choices.length) return { outcome: "unavailable", reason: "NO_LANGUAGE" };

  for (const choice of choices) {
    const candidates: AssignedVariantRow[] = [];
    for (const variant of input.variants) {
      const tag = language(variant.languageTag, input.logger, "persisted-assignment");
      if (!tag) return { outcome: "unavailable", reason: "LOCALE_UNAVAILABLE" };
      if (tag === choice.tag) candidates.push(variant);
    }
    if (candidates.length > 1) return { outcome: "unavailable", reason: "AMBIGUOUS_ASSIGNMENT" };
    if (!candidates.length) continue;
    const variant = candidates[0]!;
    // Do not fall through to another language when a *matching* slot is
    // unproven, disabled at the registration layer or otherwise unsafe.
    if (!variant.metaRegistrationId || !variant.metaRegistration) {
      return { outcome: "unavailable", reason: "LEGACY_ASSIGNMENT" };
    }
    const registration = variant.metaRegistration;
    const locale = registration.locale;
    const definition = locale.definition;
    if (registration.wabaId !== variant.providerAccountId ||
        registration.providerTemplateName !== variant.providerTemplateName ||
        registration.providerLanguageCode !== variant.providerLanguageCode ||
        registration.providerTemplateId == null ||
        registration.providerTemplateId !== variant.providerTemplateId ||
        registration.id !== variant.metaRegistrationId ||
        (locale.providerLanguageCode !== null && locale.providerLanguageCode !== registration.providerLanguageCode) ||
        language(locale.languageTag, input.logger, "registration-locale") !== choice.tag) {
      return { outcome: "unavailable", reason: "IDENTITY_MISMATCH" };
    }
    if (definition.kind !== "META_RECOVERY" ||
        definition.purpose !== input.stage || definition.offerType !== input.offer ||
        definition.providerTemplateName !== registration.providerTemplateName ||
        definition.category !== registration.category ||
        !definition.publishedAt || definition.retiredAt ||
        definition.status !== "PUBLISHED") {
      return { outcome: "unavailable", reason: "DEFINITION_UNAVAILABLE" };
    }
    if (locale.status !== "REVIEWED") {
      return { outcome: "unavailable", reason: "LOCALE_UNAVAILABLE" };
    }
    if (registration.providerStatus !== "APPROVED" ||
        !["SUBMITTED", "CONFIRMED", "APPROVED"].includes(registration.submissionState) ||
        registration.failureCode !== null) {
      return { outcome: "unavailable", reason: "PROVIDER_UNAVAILABLE" };
    }
    if (registration.driftDetectedAt ||
        (registration.lastObservedContentHash !== null &&
          registration.lastObservedContentHash !== registration.submittedContentHash) ||
        (registration.lastObservedCategory !== null &&
          registration.lastObservedCategory !== registration.category)) {
      return { outcome: "unavailable", reason: "PROVIDER_DRIFT" };
    }
    return { outcome: "selected", value: {
      variant, canonicalLanguageTag: choice.tag, selectionSource: choice.source,
    } };
  }
  return { outcome: "unavailable", reason: "NO_APPROVED_ASSIGNMENT" };
}
