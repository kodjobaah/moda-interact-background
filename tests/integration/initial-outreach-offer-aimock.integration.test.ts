import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMock } from "@copilotkit/aimock";
import { OpenRouterModelClient } from "@modainteract/moda-interact-shared/commerce/model/node";
import { runInitialOutreachOfferAgent } from "../../src/agents/initial-outreach-offer.agent.js";
import { InitialOutreachAgentContextSchema } from "../../src/agents/initial-outreach-offer.types.js";
import type { OutreachMcpToolDescriptor } from "../../src/services/recovery-offers/recovery-outreach-mcp-selector.service.js";

const localModelRoute = vi.hoisted(() => ({
  baseURL: null as string | null,
  constructions: [] as Array<{ model: string; baseURL: string }>,
}));

vi.mock("@langchain/openrouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@langchain/openrouter")>();
  return {
    ...actual,
    ChatOpenRouter: class LoopbackChatOpenRouter extends actual.ChatOpenRouter {
      constructor(fields: ConstructorParameters<typeof actual.ChatOpenRouter>[0]) {
        const baseURL = localModelRoute.baseURL;
        if (!baseURL) throw new Error("Local Aimock endpoint is required");
        const endpoint = new URL(baseURL);
        if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
          throw new Error("Aimock endpoint must use loopback HTTP");
        }
        super({ ...(typeof fields === "string" ? { model: fields } : fields), baseURL: endpoint.href });
        localModelRoute.constructions.push({ model: this.model, baseURL: this.baseURL });
      }
    },
  };
});

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

afterEach(() => {
  localModelRoute.baseURL = null;
  localModelRoute.constructions.length = 0;
});

describe("initial outreach offer agent with local Aimock", () => {
  it("routes real model/tool/model turns through loopback and returns the source-validated offer", async () => {
    const mock = new LLMock({ port: 0 });
    const timeline: string[] = [];
    const selectorCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    await mock.start();
    const endpoint = new URL(mock.url);
    expect(endpoint.protocol).toBe("http:");
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(endpoint.hostname);
    localModelRoute.baseURL = `${endpoint.origin}/v1`;

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

    const model = new OpenRouterModelClient({
      provider: "moda",
      providerModelId: "initial-outreach-aimock",
      configurationSchemaVersion: 1,
      configuration: {},
      credential: "test-only-not-a-provider-key",
    });
    expect(localModelRoute.constructions).toEqual([{
      model: modelName,
      baseURL: `${endpoint.origin}/v1`,
    }]);

    try {
      const result = await runInitialOutreachOfferAgent(context(), {
        signal: new AbortController().signal,
        modelInvoker: model,
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
      expect(localModelRoute.constructions.every(({ baseURL }) => {
        const target = new URL(baseURL);
        return target.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname);
      })).toBe(true);
    } finally {
      localModelRoute.baseURL = null;
      await mock.stop();
    }
  });
});