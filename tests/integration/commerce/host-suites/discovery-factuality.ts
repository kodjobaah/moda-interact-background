import { CommerceToolOutputs } from "@modainteract/moda-interact-shared/commerce";
import { describe, expect, it } from "vitest";
import { hostFixture as f } from "../host.fixture.js";

function configure(name: string) {
  const descriptor = f.active.capabilities[0]!.toolDescriptor;
  descriptor.name = name;
  descriptor.inputSchema = {
    type: "object",
    properties: { query: { type: "string", maxLength: 128 } },
    required: ["query"],
    additionalProperties: false,
  };
  f.active.grantedTools[0]!.toolName = name;
}
const ok = (data: unknown) => ({
  contractVersion: "commerce.v1",
  status: "OK",
  data,
  renderedText: "Untrusted synthetic tool result",
});
const historical = Array.from(
  { length: 13 },
  (_, index) => `Historical product ${index + 1}: $${100 + index}.00`,
).join("\n");
const claims =
  "We sell Historical product 1 for $100.00, and twelve more products from our catalogue.";
export function registerDiscoveryFactualityTests() {
  describe("current discovery does not authorize historical catalogue claims", () => {
    it.each([
      [
        "commerce_resolve_product_categories",
        { outcome: "UNAVAILABLE", reasonCode: "NOT_READY" },
      ],
      [
        "commerce_resolve_product_categories",
        { outcome: "UNAVAILABLE", reasonCode: "TEMPORARY_UNAVAILABLE" },
      ],
      [
        "commerce_search_products",
        { products: [], cursor: null, truncated: false },
      ],
      ["commerce_get_product", { product: null }],
    ])(
      "uses trusted referral after %s without verified facts",
      async (name, output) => {
        configure(name as string);
        CommerceToolOutputs[name as "commerce_get_product"].parse(output);
        f.toolResults = { [name as string]: ok(output) };
        const context = structuredClone(f.context);
        context.conversation.history = [
          { role: "assistant", content: historical },
        ];
        const raw = f.final({
          answerKind: "ANSWER",
          referralReason: null,
          evidenceIds: [],
          replyText: claims,
          details: {},
        });
        const before = structuredClone(raw);
        let calls = 0;
        const result = await f.run(async () => {
          calls++;
          if (calls > 2)
            throw new Error("Guard must not add a model invocation");
          return calls === 1
            ? {
                calls: [
                  { name: name as string, arguments: { query: "catalogue" } },
                ],
                outputTokens: 1,
              }
            : raw;
        }, context);
        expect(result).toMatchObject({
          answerKind: "REFER_TO_STORE",
          referralReason: "UNVERIFIABLE_FACTS",
          evidenceIds: [],
        });
        expect(result.replyText).toContain("Please contact the store directly");
        expect(result.replyText).toContain("https://");
        expect(result.replyText).not.toMatch(
          /Historical product|\$100|out of stock|nothing in stock/i,
        );
        expect(result.commercePresentation!.envelope.details).toEqual({});
        expect(raw).toEqual(before);
        expect(calls).toBe(2);
        expect(
          f.observations.filter((call) => call.method === "tools/call"),
        ).toHaveLength(1);
      },
    );
    it("does not treat taxonomy candidates as current inventory authority", async () => {
      configure("commerce_resolve_product_categories");
      f.toolResults = {
        commerce_resolve_product_categories: ok({
          outcome: "CANDIDATES",
          generationId: "taxonomy-generation",
          source: "SHOPIFY_STANDARD_PRODUCT_TAXONOMY",
          taxonomyVersion: "2026-01",
          languageTag: "en",
          candidates: [
            {
              categoryId: "taxonomy-snowboard",
              name: "Snowboards",
              fullName: "Sporting Goods > Snowboards",
              parentId: null,
              level: 0,
              ancestorIds: [],
              distance: 0,
            },
          ],
        }),
      };
      let calls = 0;
      const result = await f.run(async () =>
        ++calls === 1
          ? {
              calls: [
                {
                  name: "commerce_resolve_product_categories",
                  arguments: { query: "snowboard" },
                },
              ],
              outputTokens: 1,
            }
          : f.final({
              answerKind: "ANSWER",
              referralReason: null,
              evidenceIds: [],
              replyText: claims,
              details: {},
            }),
      );
      expect(result.answerKind).toBe("REFER_TO_STORE");
      expect(result.replyText).not.toContain("Historical product");
    });
    it.each(["commerce_search_products", "commerce_get_product"])(
      "preserves the mandatory unavailable referral for %s",
      async (name) => {
        configure(name);
        f.toolResults = {
          [name]: {
            contractVersion: "commerce.v1",
            status: "ERROR",
            code: "UNAVAILABLE",
            retryable: false,
          },
        };
        let calls = 0;
        const result = await f.run(async () =>
          ++calls === 1
            ? {
                calls: [{ name, arguments: { query: "catalogue" } }],
                outputTokens: 1,
              }
            : f.final({
                answerKind: "REFER_TO_STORE",
                referralReason: "TOOL_UNAVAILABLE",
                evidenceIds: [],
                replyText: claims,
                details: {},
              }),
        );
        expect(result).toMatchObject({
          answerKind: "REFER_TO_STORE",
          referralReason: "TOOL_UNAVAILABLE",
        });
        expect(result.replyText).not.toContain("Historical product");
        expect(calls).toBe(2);
        expect(
          f.observations.filter((call) => call.method === "tools/call"),
        ).toHaveLength(1);
      },
    );
    it("does not turn rejected model arguments into an authorized discovery attempt", async () => {
      configure("commerce_get_product");
      let calls = 0;
      const result = await f.run(async () =>
        ++calls === 1
          ? {
              calls: [
                { name: "commerce_get_product", arguments: { query: 42 } },
              ],
              outputTokens: 1,
            }
          : f.final({
              answerKind: "ANSWER",
              referralReason: null,
              evidenceIds: [],
              replyText: "Please clarify your question.",
              details: {},
            }),
      );
      expect(result.answerKind).toBe("ANSWER");
      expect(result.replyText).toBe("Please clarify your question.");
      expect(
        f.observations.filter((call) => call.method === "tools/call"),
      ).toHaveLength(0);
    });
    it("preserves existing trusted French referral rendering after an unavailable resolver", async () => {
      configure("commerce_resolve_product_categories");
      f.state.languageTag = "fr";
      f.state.languageSource = "DETECTED";
      f.toolResults = {
        commerce_resolve_product_categories: ok({
          outcome: "UNAVAILABLE",
          reasonCode: "NOT_READY",
        }),
      };
      let calls = 0;
      const result = await f.run(async () =>
        ++calls === 1
          ? {
              calls: [
                {
                  name: "commerce_resolve_product_categories",
                  arguments: { query: "catalogue" },
                },
              ],
              outputTokens: 1,
            }
          : f.final({
              answerKind: "ANSWER",
              referralReason: null,
              evidenceIds: [],
              replyText: claims,
              details: {},
            }),
      );
      expect(result.replyText).toContain("Veuillez contacter");
      expect(result.replyText).not.toContain("Historical product");
    });
    it("preserves independently refreshed shipping after a product discovery attempt without inventory facts", async () => {
      configure("commerce_get_product");
      const generic = { productId: null, variantId: null };
      f.active.responseContract.detailsSchema = {
        type: "object",
        properties: {
          responseDisposition: {
            type: "string",
            enum: ["STANDARD", "SHIPPING_INFORMATION_UNVERIFIED"],
            maxLength: 64,
          },
          shippingInformationSelection: {
            type: "object",
            properties: {
              productId: { type: ["string", "null"], maxLength: 128 },
              variantId: { type: ["string", "null"], maxLength: 128 },
            },
            required: ["productId", "variantId"],
            additionalProperties: false,
          },
        },
        required: [],
        additionalProperties: false,
      };
      f.active.responseContractHash = f.digest(
        f.responseContractCanonicalJson(f.active.responseContract),
      );
      const capability = structuredClone(f.active.capabilities[0]!);
      capability.capabilityId = "shipping-capability";
      capability.key = "shipping-read";
      capability.position = 1;
      capability.toolDescriptor = {
        ...capability.toolDescriptor,
        toolId: "shipping-tool",
        toolRevisionId: "shipping-revision",
        name: "commerce_get_shipping_information",
        inputSchema: {
          type: "object",
          properties: {
            productId: { type: ["string", "null"], maxLength: 128 },
            variantId: { type: ["string", "null"], maxLength: 128 },
          },
          required: ["productId", "variantId"],
          additionalProperties: false,
        },
      };
      f.active.capabilities.push(capability);
      f.active.selectedCapabilityKeys.push(capability.key);
      f.active.grantedTools.push({
        toolId: "shipping-tool",
        toolRevisionId: "shipping-revision",
        toolName: "commerce_get_shipping_information",
        definitionVersion: "1.0.0",
        capabilityKeys: [capability.key],
      });
      const shipping = {
        provider: "SHOPIFY",
        observedAt: "2026-11-05T00:00:00.000Z",
        product: {
          status: "NOT_REQUESTED",
          ...generic,
          requiresShipping: null,
          virtual: null,
          weight: null,
          dimensions: null,
          shippingClassId: null,
          shippingClassSlug: null,
        },
        policy: {
          status: "SCOPE_NOT_GRANTED",
          trust: "UNTRUSTED_REFERENCE",
          title: null,
          bodyStatus: "NOT_AVAILABLE",
          bodyHtml: null,
          url: null,
          updatedAt: null,
        },
      };
      CommerceToolOutputs.commerce_get_shipping_information.parse(shipping);
      f.toolResults = {
        commerce_get_product: ok({ product: null }),
        commerce_get_shipping_information: ok(shipping),
      };
      let calls = 0;
      const result = await f.run(async () => {
        calls++;
        if (calls === 1)
          return {
            calls: [
              { name: "commerce_get_product", arguments: { query: "product" } },
            ],
            outputTokens: 1,
          };
        if (calls === 2)
          return {
            calls: [
              { name: "commerce_get_shipping_information", arguments: generic },
            ],
            outputTokens: 1,
          };
        return f.final({
          answerKind: "ANSWER",
          referralReason: null,
          evidenceIds: [],
          replyText: "The shop shipping policy cannot be verified here.",
          details: {
            responseDisposition: "SHIPPING_INFORMATION_UNVERIFIED",
            shippingInformationSelection: generic,
          },
        });
      });
      expect(result.answerKind).toBe("ANSWER");
      expect(result.replyText).toContain("shipping policy");
      expect(calls).toBe(3);
      expect(
        f.observations.filter((call) => call.method === "tools/call"),
      ).toHaveLength(3);
    });
    it.each(["Hello, how can I help?", "You are welcome."])(
      "preserves ordinary no-discovery response %s",
      async (replyText) => {
        let calls = 0;
        const raw = f.final({
          answerKind: "ANSWER",
          referralReason: null,
          evidenceIds: [],
          replyText,
          details: {},
        });
        const before = structuredClone(raw);
        const result = await f.run(async () => {
          calls++;
          return raw;
        });
        expect(result.answerKind).toBe("ANSWER");
        expect(result.replyText).toBe(replyText);
        expect(calls).toBe(1);
        expect(raw).toEqual(before);
        expect(
          f.observations.filter((call) => call.method === "tools/call"),
        ).toHaveLength(0);
      },
    );
  });
}
