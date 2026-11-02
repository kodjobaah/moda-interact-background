import { describe, expect, it } from "vitest";
import { LLMock } from "@copilotkit/aimock";
import type { CommerceModelInvoker, ModelRequest } from "@modainteract/moda-interact-shared/commerce/runner";
import { runInitialOutreachOfferAgent } from "../../src/agents/initial-outreach-offer.agent.js";
import { InitialOutreachAgentContextSchema } from "../../src/agents/initial-outreach-offer.types.js";
import type { OutreachMcpToolDescriptor } from "../../src/services/recovery-offers/recovery-outreach-mcp-selector.service.js";

const offer = {
  offerId: "offer-aimock",
  title: "Basket discount",
  method: "CODE" as const,
  code: "BASKET10",
  startsAt: null,
  endsAt: null,
  support: "SUPPORTED" as const,
  reasonCodes: [],
};

const details = {
  offer,
  providerDiscountId: "provider-discount-aimock",
  facts: {
    provider: "SHOPIFY" as const,
    completeness: "COMPLETE" as const,
    observedAt: "2026-10-31T12:00:00.000Z",
    providerStatus: "ACTIVE",
    unavailableAt: null,
    discountKind: "PERCENTAGE" as const,
    discountValue: "10",
    discountCurrency: "GBP",
    targeting: {
      kind: "PRODUCTS" as const,
      includedProductIds: ["product-aimock"],
      includedVariantIds: [],
      includedCategoryIds: [],
      includedCollectionIds: [],
      excludedProductIds: [],
      excludedVariantIds: [],
      excludedCategoryIds: [],
      excludedCollectionIds: [],
    },
    minimumSubtotal: null,
    maximumSubtotal: null,
    subtotalRequirementCurrency: null,
    minimumQuantity: null,
    usageLimit: 10,
    usageCount: 0,
    perCustomerLimit: 0,
    customerScope: "ALL" as const,
    excludesSaleItems: false,
    individualUse: null,
    combination: {
      discountClasses: ["PRODUCT" as const],
      shopifyPlus: null,
      combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
      discountTags: [],
      allowedSameLineProductTags: [],
    },
    unrepresentedConditions: [],
  },
};

const tools: OutreachMcpToolDescriptor[] = [
  {
    name: "commerce_get_discount_options",
    description: "List authorised discounts",
    inputSchema: { type: "object", properties: { limit: { type: "integer" }, cursor: { type: ["string", "null"] } }, required: ["limit", "cursor"], additionalProperties: false },
  },
  {
    name: "commerce_get_discount_details",
    description: "Read source conditions for one discount",
    inputSchema: { type: "object", properties: { offerId: { type: "string" } }, required: ["offerId"], additionalProperties: false },
  },
];

function context() {
  return InitialOutreachAgentContextSchema.parse({
    shopId: "shop-aimock",
    checkoutRecoveryId: "recovery-aimock",
    outreachAttemptId: "attempt-aimock",
    environment: "TEST",
    platform: "SHOPIFY",
    mode: "AI_BEST_APPLICABLE",
    authorisedDiscountIds: [],
    basket: {
      currency: "GBP",
      subtotalMinor: 8_000,
      totalMinor: 9_600,
      fingerprint: "b".repeat(64),
      generation: 3,
      items: [{
        lineKey: "line-0001",
        productId: "product-aimock",
        variantId: "variant-aimock",
        categoryIds: null,
        collectionIds: null,
        isSaleItem: false,
        title: "Basket item",
        category: null,
        quantity: 1,
        lineTotalMinor: 8_000,
      }],
    },
    priceReconciliation: {
      shopId: "shop-aimock",
      checkoutRecoveryId: "recovery-aimock",
      outreachAttemptId: "attempt-aimock",
      generation: 3,
      basketFingerprint: "b".repeat(64),
      evaluatedAt: "2026-10-31T12:00:00.000Z",
      completeness: "COMPLETE",
      reasonCodes: [],
      currentMerchandiseSubtotal: { amountDecimal: "80.00", currency: "GBP" },
      lines: [{
        lineKey: "line-0001",
        productId: "product-aimock",
        variantId: "variant-aimock",
        quantity: 1,
        checkoutUnitPrice: "80.00",
        checkoutCurrency: "GBP",
        catalogueUnitPrice: "80.00",
        catalogueCurrency: "GBP",
        catalogueObservedAt: "2026-10-31T12:00:00.000Z",
        catalogueComparison: "EQUAL",
        checkoutPriceChange: "UNVERIFIABLE",
        reasonCodes: [],
      }],
    },
    platformInstructions: "Use source evidence only.",
    merchantInstructions: null,
    platformInstructionRevisionId: "platform-revision-aimock",
    merchantInstructionRevisionId: null,
  });
}

describe("initial outreach offer agent with local Aimock", () => {
  it("routes real model/tool/model turns through loopback and returns the source-validated offer", async () => {
    const mock = new LLMock({ port: 0 });
    const timeline: string[] = [];
    const selectorCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    await mock.start();
    const endpoint = new URL(mock.url);
    expect(endpoint.protocol).toBe("http:");
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(endpoint.hostname);

    const modelName = "moda/initial-outreach-aimock";
    mock.on({ model: modelName, sequenceIndex: 0 }, () => {
      timeline.push("model");
      return { toolCalls: [{ name: "commerce_get_discount_options", arguments: { limit: 10, cursor: null } }] };
    });
    mock.on({ model: modelName, sequenceIndex: 1 }, () => {
      timeline.push("model");
      return { toolCalls: [{ name: "commerce_get_discount_details", arguments: { offerId: offer.offerId } }] };
    });
    mock.on({ model: modelName, sequenceIndex: 2 }, () => {
      timeline.push("model");
      return { toolCalls: [{ name: "submitInitialOutreachOffer", arguments: { kind: "CHECKOUT_DISCOUNT", offerIds: [offer.offerId] } }] };
    });

    const modelInvoker: CommerceModelInvoker = {
      async invoke(request: ModelRequest, signal: AbortSignal) {
        const response = await fetch(`${endpoint.origin}/v1/chat/completions`, {
          method: "POST",
          headers: { authorization: "Bearer test-only-local-aimock", "content-type": "application/json" },
          body: JSON.stringify({
            model: modelName,
            messages: [
              { role: "system", content: request.instructions.join("\n") },
              { role: "user", content: JSON.stringify({
                context: request.context, history: request.history, messages: request.messages,
              }) },
            ],
            tools: request.tools.map((tool) => ({
              type: "function", function: { name: tool.name, description: tool.description,
                parameters: tool.inputSchema },
            })),
            max_tokens: request.maxOutputTokens,
            stream: false,
          }),
          signal,
        });
        if (!response.ok) throw new Error(`Local Aimock returned HTTP ${response.status}`);
        const body = await response.json() as {
          choices?: Array<{ message?: { tool_calls?: Array<{
            function?: { name?: string; arguments?: string };
          }> } }>;
          usage?: { completion_tokens?: number };
        };
        const calls = body.choices?.[0]?.message?.tool_calls ?? [];
        if (calls.length !== 1 || !calls[0]?.function?.name || !calls[0].function.arguments) {
          throw new Error("Local Aimock did not produce exactly one tool call");
        }
        return {
          calls: [{ name: calls[0].function.name,
            arguments: JSON.parse(calls[0].function.arguments) as unknown }],
          outputTokens: body.usage?.completion_tokens ?? 0,
        };
      },
    };

    try {
      const result = await runInitialOutreachOfferAgent(context(), {
        signal: new AbortController().signal,
        modelInvoker,
        createSelector: () => ({
          async connect() {},
          async tools() { return tools; },
          async call(name: string, args: Record<string, unknown>) {
            timeline.push(`tool:${name}`);
            selectorCalls.push({ name, args });
            if (name === "commerce_get_discount_options") {
              return { contractVersion: "commerce.v1", status: "OK", data: {
                mode: "AI_BEST_APPLICABLE", offers: [offer], cursor: null, truncated: false,
              }, renderedText: "Source options." };
            }
            if (name === "commerce_get_discount_details") {
              return { contractVersion: "commerce.v1", status: "OK", data: { details }, renderedText: "Source details." };
            }
            throw new Error("Unexpected MCP tool");
          },
          async close() {},
        } as never),
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });

      const requests = mock.getRequests().filter((entry) =>
        entry.method === "POST" && entry.path.endsWith("/chat/completions"));
      expect(requests).toHaveLength(3);
      expect(timeline).toEqual([
        "model",
        "tool:commerce_get_discount_options",
        "model",
        "tool:commerce_get_discount_details",
        "model",
      ]);
      expect(selectorCalls.map(({ name }) => name)).toEqual([
        "commerce_get_discount_options",
        "commerce_get_discount_details",
      ]);
      expect(selectorCalls[1]?.args).toEqual({ offerId: "offer-aimock" });
      for (const request of requests) {
        expect(request.response.status).toBe(200);
        expect((request.body as { model: string }).model).toBe(modelName);
      }
      expect(result).toMatchObject({
        kind: "CHECKOUT_DISCOUNT",
        offerSet: { offers: [{ offerId: offer.offerId, providerDiscountId: details.providerDiscountId, code: offer.code }] },
        members: [{ eligibility: { verdict: "SUPPORTED", eligibleLineKeys: ["line-0001"] } }],
        generation: 3,
        fingerprint: "b".repeat(64),
      });
    } finally {
      await mock.stop();
    }
  });
});