import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { exampleManifest, type CommerceResponseContract } from "@modainteract/moda-interact-shared/commerce";
import { RECOVERY_STRUCTURED_FINALIZATION_INSTRUCTION, structuredFinalizationInstructions } from "../../../src/commerce/structured-finalization-instructions.js";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function contract(): CommerceResponseContract {
  const value = exampleManifest(digest, true).responseContract;
  value.detailsSchema = { type: "object", properties: {}, required: [], additionalProperties: false };
  return value;
}
const identityArray = { type: "array" as const, maxItems: 3, items: { type: "object" as const, properties: {
  productId: { type: "string" as const, maxLength: 128 }, variantId: { type: ["string", "null"] as Array<"string" | "null">, maxLength: 128 },
}, required: ["productId", "variantId"], additionalProperties: false } };
describe("recovery application structured finalization guidance", () => {
  it("requires the existing finalResponse for simple/referral/nonproduct/custom turns without inventing selection fields", () => {
    const value = contract(); value.detailsSchema.properties = { customAnswer: { type: "string", enum: ["CUSTOM_ONLY"] } };
    expect(structuredFinalizationInstructions(value)).toEqual([RECOVERY_STRUCTURED_FINALIZATION_INSTRUCTION]);
    expect(RECOVERY_STRUCTURED_FINALIZATION_INSTRUCTION).toContain("clarifications and referrals");
    expect(RECOVERY_STRUCTURED_FINALIZATION_INSTRUCTION).toContain("do not invent products, selections or evidence");
  });
  it.each(["productDetailSelections", "productOptionSelections"])("describes only the pinned supported identity array %s and preserves contract bytes", field => {
    const value = contract(); value.detailsSchema.properties![field] = structuredClone(identityArray);
    const before = structuredClone(value); const result = structuredFinalizationInstructions(value);
    expect(result).toHaveLength(2); expect(result[1]).toContain(`details.${field}`);
    expect(result[1]).toContain("exact productId and variantId from authorized observations");
    expect(value).toEqual(before); expect(result.join("\n")).not.toContain("responseDisposition");
  });
  it.each([{}, { type: "string" }, { ...identityArray, maxItems: 0 }, { ...identityArray, items: { type: "object", properties: { productId: { type: "integer" }, variantId: { type: "string" } } } }])("does not advertise unsupported/custom identity fields %s", schema => {
    const value = contract(); value.detailsSchema.properties = { productDetailSelections: schema as typeof identityArray };
    expect(structuredFinalizationInstructions(value)).toEqual([RECOVERY_STRUCTURED_FINALIZATION_INSTRUCTION]);
  });
  it("does not invent recommendation version1 for an incompatible custom contract", () => {
    const value = contract(); value.detailsSchema.properties = {
      productRecommendationVersion: { type: "string", enum: ["CUSTOM"] }, productRecommendations: structuredClone(identityArray),
    };
    expect(structuredFinalizationInstructions(value)).toEqual([RECOVERY_STRUCTURED_FINALIZATION_INSTRUCTION]);
  });  it("guides canonical recommendations only when actual pinned fields support version1 and observed identities", () => {
    const value = contract(); value.detailsSchema.properties = {
      productRecommendationVersion: { type: "string", enum: ["1"] }, productRecommendations: structuredClone(identityArray),
    };
    expect(structuredFinalizationInstructions(value).join("\n")).toContain('productRecommendationVersion set to "1"');
    value.detailsSchema.properties.productRecommendations = { type: "string" };
    expect(structuredFinalizationInstructions(value)).toEqual([RECOVERY_STRUCTURED_FINALIZATION_INSTRUCTION]);
    value.detailsSchema.properties.productRecommendations = structuredClone(identityArray);
    value.detailsSchema.properties.productRecommendationVersion = { type: "string", enum: ["2"] };
    expect(structuredFinalizationInstructions(value)).toEqual([RECOVERY_STRUCTURED_FINALIZATION_INSTRUCTION]);
  });

});
