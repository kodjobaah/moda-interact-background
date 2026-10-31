import { describe, expect, it, vi } from "vitest";
import { runInitialOutreachOfferAgent } from "../../../src/agents/initial-outreach-offer.agent.js";
import { CommerceHostError, type McpSourceFailure } from "../../../src/commerce/mcp-client.js";

function context(overrides: Record<string, unknown> = {}) {
  return {
    shopId: "shop-1",
    checkoutRecoveryId: "recovery-1",
    outreachAttemptId: "attempt-1",
    environment: "TEST",
    platform: "SHOPIFY",
    mode: "NONE",
    authorisedDiscountIds: [],
    basket: {
      currency: "GBP",
      subtotalMinor: null,
      totalMinor: null,
      fingerprint: "a".repeat(64),
      generation: 1,
      items: [{ lineKey: "line-0001", productId: "product-1", variantId: "variant-1",
        categoryIds: null, collectionIds: null, isSaleItem: null, title: "Item", category: null,
        quantity: 1, lineTotalMinor: null }],
    },
    priceReconciliation: null,
    platformInstructions: "Platform safety.",
    merchantInstructions: null,
    platformInstructionRevisionId: "platform-revision-1",
    merchantInstructionRevisionId: null,
    ...overrides,
  };
}

describe("runInitialOutreachOfferAgent", () => {
  it("returns POLICY_NONE without constructing an MCP client or model invoker", async () => {
    const createSelector = vi.fn();
    const createModelInvoker = vi.fn();
    const result = await runInitialOutreachOfferAgent(context(), {
      signal: new AbortController().signal,
      createSelector,
      createModelInvoker,
    });

    expect(result).toEqual({ kind: "NO_VERIFIED_OFFER", reason: "POLICY_NONE", discoveryIncomplete: false });
    expect(createSelector).not.toHaveBeenCalled();
    expect(createModelInvoker).not.toHaveBeenCalled();
  });

  it("returns NO_AUTHORISED_DISCOUNTS without tool discovery or model creation for empty FIXED policy", async () => {
    const createSelector = vi.fn();
    const createModelInvoker = vi.fn();
    const result = await runInitialOutreachOfferAgent(context({ mode: "FIXED" }), {
      signal: new AbortController().signal,
      createSelector,
      createModelInvoker,
    });

    expect(result).toEqual({ kind: "NO_VERIFIED_OFFER", reason: "NO_AUTHORISED_DISCOUNTS", discoveryIncomplete: false });
    expect(createSelector).not.toHaveBeenCalled();
    expect(createModelInvoker).not.toHaveBeenCalled();
  });

  it("rejects stale attempt-scoped price reports before creating external dependencies", async () => {
    const createSelector = vi.fn();
    const createModelInvoker = vi.fn();
    const result = await runInitialOutreachOfferAgent(context({
      mode: "AI_BEST_APPLICABLE",
      priceReconciliation: {
        shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "another-attempt",
        generation: 1, basketFingerprint: "a".repeat(64), evaluatedAt: "2026-10-31T12:00:00.000Z",
        lines: [], reasonCodes: [], currentMerchandiseSubtotal: null, completeness: "PARTIAL",
      },
    }), {
      signal: new AbortController().signal,
      createSelector,
      createModelInvoker,
    });

    expect(result).toMatchObject({ kind: "FAILURE", code: "INVALID_RESULT", reasonCode: "PRICE_PREFLIGHT_IDENTITY_MISMATCH" });
    expect(createSelector).not.toHaveBeenCalled();
    expect(createModelInvoker).not.toHaveBeenCalled();
  });

  it("logs a source-preserved MCP response once with outreach correlation and retains DENIED", async () => {
    const sourceFailure: McpSourceFailure = {
      origin: "mcp_response",
      provider: "commerce-mcp",
      operation: "initialize",
      httpStatus: 401,
      providerRequestId: "request-safe-1",
      providerError: { code: "AUTH_FAILED", message: "MCP assertion rejected" },
      redactionApplied: false,
      truncated: false,
    };
    const connectError = new CommerceHostError("DENIED", false, undefined, undefined, sourceFailure);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await runInitialOutreachOfferAgent(context({
      mode: "AI_BEST_APPLICABLE",
      priceReconciliation: {
        shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
        generation: 1, basketFingerprint: "a".repeat(64), evaluatedAt: "2026-10-31T12:00:00.000Z",
        lines: [{ lineKey: "line-0001", productId: "product-1", variantId: "variant-1", quantity: 1,
          checkoutUnitPrice: null, checkoutCurrency: null, catalogueUnitPrice: null, catalogueCurrency: null,
          catalogueObservedAt: null, catalogueComparison: "INCOMPARABLE", checkoutPriceChange: "UNVERIFIABLE", reasonCodes: [] }],
        reasonCodes: [], currentMerchandiseSubtotal: null, completeness: "PARTIAL",
      },
    }), {
      signal: new AbortController().signal,
      logger,
      createSelector: () => ({
        connect: vi.fn().mockRejectedValue(connectError),
        tools: vi.fn(),
        call: vi.fn(),
        close: vi.fn().mockRejectedValue(new Error("MCP close handshake failed")),
      } as never),
      modelInvoker: { invoke: vi.fn() } as never,
    });

    expect(result).toMatchObject({ kind: "FAILURE", code: "DENIED", reasonCode: "MCP_DENIED" });
    const sourceEvents = logger.error.mock.calls.filter(([, fields]) => fields.origin === "mcp_response");
    expect(sourceEvents).toHaveLength(1);
    expect(sourceEvents[0]).toEqual(["outreach.offer_agent.failed", expect.objectContaining({
      shopId: "shop-1", recoveryId: "recovery-1", outreachAttemptId: "attempt-1",
      operation: "initialize", reasonCode: "MCP_DENIED", httpStatus: 401,
      providerError: { code: "AUTH_FAILED", message: "MCP assertion rejected" },
    })]);
    expect(logger.error).toHaveBeenCalledWith("outreach.offer_agent.failed", expect.objectContaining({
      operation: "mcp.close", origin: "sdk_exception",
      sourceError: { name: "Error", message: "MCP close handshake failed" },
      primaryFailurePresent: true,
    }));
  });
});