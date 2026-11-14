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
      if (field === "productDetailSelections") {
        const item = selection?.items;
        const required = item?.required ?? [];
        const allowed = Object.keys(item?.properties ?? {});
        if (required.includes("productId") && required.includes("variantId") &&
            required.every(key => key === "productId" || key === "variantId") &&
            allowed.includes("productId") && allowed.includes("variantId")) {
          const limit = Math.min(3, selection?.maxItems ?? 3);
          instructions.push(`Category, catalogue and availability questions such as what do you sell are product-facts answers when successful authorized observations contain relevant products, even when the customer is not asking for a recommendation. Select at most ${limit} relevant observed product/variant pairs in details.productDetailSelections. The details shape is {"productDetailSelections":[{"productId":<exact observed productId>,"variantId":<exact observed variantId>}]}; angle-bracket values describe bindings, not literal IDs. Use null for variantId only when both the observation and pinned schema permit null. Do not substitute category-name prose or empty details for these selections. Do not create productRecommendations merely to enumerate the catalogue or infer discounts or promotion authority. If no relevant authorized product observation is available, preserve the existing clarification or referral behavior; never fabricate a selection. Preserve configured language, shipping limitations and required referral reasons.`);
        }
      }
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
