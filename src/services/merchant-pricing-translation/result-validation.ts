export type MerchantPricingTranslationResultField = {
  sourceEntityKind: "PLAN" | "HIGHLIGHT";
  sourceField: "TITLE" | "DESCRIPTION";
};

const PLAN_DESCRIPTION_MAX_LENGTH = 2_000;
const HIGHLIGHT_TITLE_MAX_LENGTH = 120;
const HIGHLIGHT_DESCRIPTION_MAX_LENGTH = 500;

export function validateMerchantPricingTranslatedText(
  field: MerchantPricingTranslationResultField,
  translatedText: string | null | undefined,
): string | null {
  const value = translatedText?.trim();
  if (!value) return null;

  if (field.sourceEntityKind === "PLAN") {
    return field.sourceField === "DESCRIPTION" && value.length <= PLAN_DESCRIPTION_MAX_LENGTH
      ? value
      : null;
  }

  if (field.sourceField === "TITLE") {
    return value.length <= HIGHLIGHT_TITLE_MAX_LENGTH ? value : null;
  }
  if (field.sourceField === "DESCRIPTION") {
    return value.length <= HIGHLIGHT_DESCRIPTION_MAX_LENGTH ? value : null;
  }
  return null;
}
