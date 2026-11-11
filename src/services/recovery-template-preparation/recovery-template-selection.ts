import { selectRecoveryAssignment as sharedSelect } from "@modainteract/moda-interact-shared/commerce/outreach";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { AssignedVariantRow, RecoveryStage, SelectionSource, ShopSelectionRow, TemplateUnavailableReason, VerifiedOfferPresentation } from "./recovery-template.types.js";
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
  promotionTarget?: "CHECKOUT" | "ALTERNATIVE_PRODUCT";
  offer: VerifiedOfferPresentation;
  offerCount?: number;
  conversationLanguageTag: string | null;
  merchantLanguageTag: string | null;
  platformFallbackEnabled: boolean;
  platformFallbackLanguageTag: string | null;
  headerFormat?: "TEXT" | "IMAGE";
  checkoutProductHeaderAvailable?: boolean;
  hasCustomerFirstName?: boolean;
  logger: Pick<StructuredLogger, "warn">;
}): AssignmentSelection {
  // The published projection uses ISO dates; repository Date values remain host-owned.
  return sharedSelect({ ...JSON.parse(JSON.stringify(input)), logger: input.logger }) as unknown as AssignmentSelection;
}
