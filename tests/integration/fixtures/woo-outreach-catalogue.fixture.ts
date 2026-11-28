import { vi } from "vitest";
import {
  CommerceToolOutputs,
  CommerceToolResultSchema,
} from "@modainteract/moda-interact-shared/commerce";
import { RecoveryOutreachMcpSelectorService } from "../../../src/services/recovery-offers/recovery-outreach-mcp-selector.service.js";
import { WOO_TEST_PRODUCT_ID } from "./arch048-woo-outreach.fixture.js";

export const WOO_COMPOSED_FIRST_PRODUCT_ID = "102";
export const WOO_COMPOSED_SECOND_PRODUCT_ID = "103";
const products = new Map([
  [WOO_TEST_PRODUCT_ID, { title: "Test item", unitPrice: "10.00" }],
  [
    WOO_COMPOSED_FIRST_PRODUCT_ID,
    { title: "Test product", unitPrice: "20.00" },
  ],
  [
    WOO_COMPOSED_SECOND_PRODUCT_ID,
    { title: "Generation two product", unitPrice: "17.50" },
  ],
]);

/** Replace only the remote catalogue boundary. The production context, LIVE
 * budget, Shared evaluation (including the second exact-product read),
 * revalidation, template preparation, sender ownership and settlement run.
 * The endpoint is loopback and never contacted; no live merchant or model
 * credentials are needed. Unexpected tools or product identities fail closed.
 */
export function mockWooOutreachCatalogue() {
  if (process.env.MODA_DISPOSABLE_INTEGRATION !== "1")
    throw new Error(
      "Woo catalogue fixture requires disposable integration infrastructure",
    );
  vi.stubEnv("COMMERCE_MCP_URL", "http://127.0.0.1:1/api/mcp");
  const selector = RecoveryOutreachMcpSelectorService.prototype;
  const inputSchema = {
    type: "object",
    properties: {
      productId: { type: "string", maxLength: 128 },
      variantId: { type: ["string", "null"], maxLength: 128 },
    },
    required: ["productId", "variantId"],
    additionalProperties: false,
  };
  vi.spyOn(selector, "connect").mockResolvedValue(undefined);
  vi.spyOn(selector, "tools").mockResolvedValue([
    {
      name: "commerce_get_product",
      description: "Read a fixture product",
      inputSchema,
    },
  ]);
  // The selector transport and profile negotiation are covered by their own
  // tests; this fixture supplies only the trusted no-discount catalogue prompt.
  vi.spyOn(selector, "profile").mockReturnValue({
    purpose: "INITIAL_RECOVERY_OUTREACH",
    featureId: "fixture-feature",
    releaseId: "fixture-release",
    behaviourPrompt: "Read only the checkout products.",
    capabilities: [],
  });
  vi.spyOn(selector, "close").mockResolvedValue(undefined);
  return vi
    .spyOn(selector, "call")
    .mockImplementation(async (name, raw, signal) => {
      signal?.throwIfAborted();
      if (
        name !== "commerce_get_product" ||
        !raw ||
        typeof raw !== "object" ||
        !("productId" in raw) ||
        typeof raw.productId !== "string" ||
        !("variantId" in raw) ||
        raw.variantId !== null
      ) {
        throw new Error("Unexpected Woo fixture catalogue request");
      }
      const productId = raw.productId;
      const entry = products.get(productId);
      if (!entry) throw new Error(`Unknown Woo fixture product: ${productId}`);
      const data = CommerceToolOutputs.commerce_get_product.parse({
        product: {
          productId,
          variantId: null,
          ...entry,
          available: true,
          currency: "GBP",
          url: `https://catalogue.example.com/products/${productId}`,
          productType: null,
          vendor: null,
          categories: [],
          categoryIds: [],
          collectionIds: [],
          saleEvidence: null,
          observedAt: new Date().toISOString(),
        },
      });
      return CommerceToolResultSchema.parse({
        contractVersion: "commerce.v1",
        status: "OK",
        data,
        renderedText: "Disposable catalogue product",
      });
    });
}
