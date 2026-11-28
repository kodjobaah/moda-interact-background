import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  exampleFinal,
  exampleTurn,
} from "@modainteract/moda-interact-shared/commerce";
import {
  verifyCommerceProductFacts,
  type CommerceVerifiedPresentation,
} from "@modainteract/moda-interact-shared/commerce/presentation";
import { renderRefreshedRecoveryIdentityDecision } from "../../../src/commerce/identity-terminal-presentation.js";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const pair = { productId: "p-current", variantId: null };
const product = {
  ...pair,
  title: "Current product",
  url: null,
  available: true,
  unitPrice: "12.00",
  currency: "GBP",
  productType: "Shirt",
  vendor: "Shop",
  categories: [],
  categoryIds: [],
  collectionIds: [],
  saleEvidence: null,
  observedAt: "2026-11-05T12:00:00Z",
  stock: { status: "KNOWN", scope: "PRODUCT", quantity: 4 },
};
function fixture() {
  const verified = verifyCommerceProductFacts([pair], [product]);
  if (verified.kind !== "verified") throw Error("Invalid fixture");
  const original = {
    ...exampleFinal,
    answerKind: "ANSWER" as const,
    referralReason: null,
    evidenceIds: [],
    replyText: "Old title and stock from initial observation",
    details: { productDetailSelections: [pair] },
  };
  const receipt = {
    binding: {
      turn: exampleTurn,
      modelStep: 3,
      callId: "actual-id",
      toolName: "recovery_complete_details",
      rawCallSha256: "a".repeat(64),
      callIds: ["actual-id"],
      rawStepSha256: "c".repeat(64),
      rawCallsSha256: "d".repeat(64),
      responseContractHash: "b".repeat(64),
    },
    mode: "PRODUCT_DETAILS" as const,
    canonicalSha256: digest(canonicalJson(original)),
  };
  const presentation: CommerceVerifiedPresentation = {
    schemaVersion: 1,
    brandName: null,
    locale: "en",
    disposition: "PRODUCT_DETAILS",
    storeUrl: "https://fixture.example",
    products: [],
    productFacts: verified.productFacts,
    optionFacts: [],
    requiresShipping: null,
    policyUrl: null,
    includeNoVerifiedOffer: false,
  };
  return {
    receipt,
    original,
    turn: exampleTurn,
    responseContractHash: "b".repeat(64),
    presentation,
    currentProducts: [product],
    digest,
  };
}
describe("bound refreshed identity terminal presentation", () => {
  it("renders only independently refreshed stock and price, not initial body claims", () => {
    const input = fixture();
    const before = structuredClone(input.original);
    const body = renderRefreshedRecoveryIdentityDecision(input);
    expect(body).toContain("Current product");
    expect(body).toContain("12.00");
    expect(body).toContain("4");
    expect(body).not.toContain("Old title");
    expect(input.original).toEqual(before);
  });
  it.each(["canonical", "turn", "contract", "pair", "mode"])(
    "fails closed for mismatched %s provenance",
    (kind) => {
      const input = fixture();
      if (kind === "canonical")
        input.original.replyText = "Changed ordinary model response";
      if (kind === "turn")
        input.turn = {
          ...input.turn,
          inboundVersion: input.turn.inboundVersion + 1,
        };
      if (kind === "contract") input.responseContractHash = "c".repeat(64);
      if (kind === "pair")
        input.presentation.productFacts[0]!.productId = "foreign";
      if (kind === "mode") input.presentation.disposition = "STANDARD";
      expect(() => renderRefreshedRecoveryIdentityDecision(input)).toThrow();
    },
  );
});
