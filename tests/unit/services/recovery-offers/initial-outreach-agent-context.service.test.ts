import { describe, expect, it, vi } from "vitest";
import { InitialOutreachAgentContextService } from "../../../../src/services/recovery-offers/initial-outreach-agent-context.service.js";

function fixture(input: { mode?: "NONE" | "AI_BEST_APPLICABLE"; invalidShopPrompt?: boolean } = {}) {
  const shopId = "shop-context";
  const recoveryId = "recovery-context";
  const attemptId = "attempt-context";
  const recovery = {
    id: recoveryId, shopId, generation: 1, currency: "GBP", totalPrice: "20.00",
    lineItems: [{ productId: "product-1", variantId: "variant-1", title: "Item", quantity: 1, price: "20.00" }],
    status: "DETECTED",
  };
  const attempt = {
    id: attemptId, checkoutRecoveryId: recoveryId, sequence: 1, trigger: "INITIAL",
    status: "PENDING", initiatedBy: null,
  };
  const configurations = [
    { scope: "PLATFORM", shopId: null, activePromptRevisionId: "platform-revision", activePromptRevision: {
      id: "platform-revision", status: "PUBLISHED", promptText: "Platform safety.", prompt: { scope: "PLATFORM", shopId: null },
    } },
    { scope: "SHOP", shopId, activePromptRevisionId: "shop-revision", activePromptRevision: {
      id: "shop-revision", status: input.invalidShopPrompt ? "DRAFT" : "PUBLISHED", promptText: "Merchant preference.",
      prompt: { scope: "SHOP", shopId },
    } },
  ];
  const reconcile = vi.fn(async (request: { expectedGeneration: number; expectedBasketFingerprint: string }) => ({
    shopId, checkoutRecoveryId: recoveryId, outreachAttemptId: attemptId, generation: request.expectedGeneration,
    basketFingerprint: request.expectedBasketFingerprint, evaluatedAt: "2026-10-31T12:00:00.000Z",
    lines: [{ lineKey: "line-0001", productId: "product-1", variantId: "variant-1", quantity: 1,
      checkoutUnitPrice: "20.00", checkoutCurrency: "GBP", catalogueUnitPrice: null, catalogueCurrency: null,
      catalogueObservedAt: null, catalogueComparison: "INCOMPARABLE" as const,
      checkoutPriceChange: "UNVERIFIABLE" as const, reasonCodes: [] }],
    reasonCodes: [], currentMerchandiseSubtotal: null, completeness: "PARTIAL" as const,
  }));
  const db = {
    checkoutRecovery: { findFirst: vi.fn(async () => recovery) },
    recoveryOutreachAttempt: { findFirst: vi.fn(async () => attempt) },
    shop: { findUnique: vi.fn(async () => ({ id: shopId, platform: "SHOPIFY" })) },
    commerceAgentConfiguration: { findMany: vi.fn(async () => configurations) },
  };
  const service = new InitialOutreachAgentContextService({
    db: db as never,
    environment: "TEST",
    policyService: { resolve: vi.fn(async () => ({
      recoveryOfferMode: input.mode ?? "AI_BEST_APPLICABLE", fixedShopifyDiscountId: null,
    })) } as never,
    priceReconciliationService: { reconcile } as never,
    now: () => new Date("2026-10-31T12:00:00.000Z"),
  });
  return { service, reconcile, shopId, recoveryId, attemptId };
}

describe("InitialOutreachAgentContextService", () => {
  it("rejects an active shop prompt projection that is not published", async () => {
    const test = fixture({ invalidShopPrompt: true });
    await expect(test.service.build({
      shopId: test.shopId, checkoutRecoveryId: test.recoveryId, outreachAttemptId: test.attemptId,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ name: "InitialOutreachAgentContextError", reasonCode: "SHOP_INSTRUCTIONS_INVALID" });
  });

  it("does not run BG016 reconciliation for NONE mode", async () => {
    const test = fixture({ mode: "NONE" });
    const context = await test.service.build({
      shopId: test.shopId, checkoutRecoveryId: test.recoveryId, outreachAttemptId: test.attemptId,
      signal: new AbortController().signal,
    });
    expect(context).toMatchObject({ mode: "NONE", priceReconciliation: null, authorisedDiscountIds: [] });
    expect(test.reconcile).not.toHaveBeenCalled();
  });
});