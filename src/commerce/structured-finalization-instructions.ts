import {
  hasCanonicalCommerceRecommendationContract,
  type CommerceResponseContract,
  type SubsetSchema,
} from "@modainteract/moda-interact-shared/commerce";

export const RECOVERY_STRUCTURED_FINALIZATION_INSTRUCTION = "Complete every customer-facing turn by calling finalResponse exactly once, including simple answers, clarifications and referrals. Do not finish with a plain-text model response. Use the verified pinned finalResponse envelope and its supported fields; retain the configured reply language and existing referral reasons. For nonproduct answers or clarifications, do not invent products, selections or evidence.";

function supportsObservedIdentityArray(selection: SubsetSchema | undefined): boolean {
  const productId = selection?.items?.properties?.productId;
  const variantId = selection?.items?.properties?.variantId;
  return selection?.type === "array" && (selection.maxItems === undefined || selection.maxItems > 0) && selection.items?.type === "object" &&
    productId?.type === "string" &&
    (variantId?.type === "string" || Array.isArray(variantId?.type) && variantId.type.includes("string"));
}

/** Format guidance only; the verified pinned contract remains the validator. */
export function structuredFinalizationInstructions(contract: CommerceResponseContract): string[] {
  const instructions: string[] = [RECOVERY_STRUCTURED_FINALIZATION_INSTRUCTION];
  const properties = contract.detailsSchema.properties;
  for (const [field, purpose] of [["productDetailSelections", "product details"], ["productOptionSelections", "product options"]] as const) {
    const selection = properties?.[field];
    if (supportsObservedIdentityArray(selection)) {
      instructions.push(`For ${purpose}, finish with a nonempty details.${field} array using the exact productId and variantId from authorized observations, as accepted by the pinned field schema. Never invent identities or use prose in place of these selections.`);
    }
  }
  const version = properties?.productRecommendationVersion;
  if (hasCanonicalCommerceRecommendationContract(contract) &&
      version?.type === "string" && version.enum?.includes("1") &&
      supportsObservedIdentityArray(properties?.productRecommendations)) {
    instructions.push('For product recommendations, finish with details.productRecommendationVersion set to "1" and a nonempty details.productRecommendations array. Use exact observed product and variant identities and only the selection fields and enum values permitted by the pinned schema; preserve all existing discount inspection and authorization requirements. Never invent identities or use prose in place of these selections.');
  }
  return instructions;
}
