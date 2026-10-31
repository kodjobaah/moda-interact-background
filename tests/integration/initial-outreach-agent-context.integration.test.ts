import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { InitialOutreachAgentContextService } from "../../src/services/recovery-offers/initial-outreach-agent-context.service.js";
import type { CheckoutPriceReconciliation } from "../../src/services/recovery-pricing/checkout-price-reconciliation.types.js";
import type { PriceReconciliationInput } from "../../src/services/recovery-pricing/checkout-price-reconciliation.types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

describeWithDatabase("Initial outreach trusted context PostgreSQL assembly", () => {
  it("binds current shop policy, sequence-one attempt, published instructions and same-fingerprint price evidence", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const suffix = randomUUID();
    const shopId = `initial-outreach-${suffix}`;
    const recoveryId = `recovery-${suffix}`;
    const attemptId = `attempt-${suffix}`;
    const platformPromptId = `platform-prompt-${suffix}`;
    const shopPromptId = `shop-prompt-${suffix}`;
    const platformRevisionId = `platform-revision-${suffix}`;
    const shopRevisionId = `shop-revision-${suffix}`;
    const now = new Date("2026-10-31T12:00:00.000Z");
    const lineItems = [{
      productId: "product-17", variantId: "variant-9", title: "Wool coat", variantTitle: "Blue",
      sku: "coat-blue", quantity: 2, price: "44.50", categoryIds: ["category-outerwear"],
      collectionIds: ["collection-winter"], isSaleItem: false, category: "Coats",
      customerEmail: "must-not-enter-agent-context@example.test",
    }];
    try {
      await db.shop.create({ data: {
        id: shopId, domain: `${suffix}.myshopify.com`, platform: "SHOPIFY", status: "ACTIVE",
      } });
      await db.shopSettings.create({ data: {
        shopId, recoveryOfferMode: "AI_BEST_APPLICABLE", fixedShopifyDiscountId: null,
      } });
      await db.checkoutRecovery.create({ data: {
        id: recoveryId, shopId, checkoutToken: `token-${suffix}`, status: "DETECTED", generation: 4,
        currency: "GBP", totalPrice: "109.00", lineItems, lastExternalActivityAt: now,
      } });
      await db.recoveryOutreachAttempt.create({ data: {
        id: attemptId, checkoutRecoveryId: recoveryId, recipient: "447400123456", sequence: 1,
        trigger: "INITIAL", status: "PENDING", initiatedBy: null,
        configuredOfferMode: "AI_BEST_APPLICABLE",
      } });
      await db.commerceAgentPrompt.createMany({ data: [
        { id: platformPromptId, scope: "PLATFORM", shopId: null },
        { id: shopPromptId, scope: "SHOP", shopId },
      ] });
      await db.commerceAgentPromptRevision.createMany({ data: [
        { id: platformRevisionId, promptId: platformPromptId, revisionNumber: 1, status: "PUBLISHED",
          promptText: "Platform safety rules.", publishedAt: now },
        { id: shopRevisionId, promptId: shopPromptId, revisionNumber: 1, status: "PUBLISHED",
          promptText: "Prefer winter outerwear.", publishedAt: now },
      ] });
      await db.commerceAgentConfiguration.createMany({ data: [
        { environment: "TEST", scope: "PLATFORM", shopId: null, activePromptRevisionId: platformRevisionId },
        { environment: "TEST", scope: "SHOP", shopId, activePromptRevisionId: shopRevisionId },
      ] });

      const priceReconciliationService = {
        reconcile: vi.fn(async (input: PriceReconciliationInput): Promise<CheckoutPriceReconciliation> => ({
          shopId: input.shopId,
          checkoutRecoveryId: input.checkoutRecoveryId,
          outreachAttemptId: input.outreachAttemptId,
          generation: input.expectedGeneration,
          basketFingerprint: input.expectedBasketFingerprint,
          evaluatedAt: now.toISOString(),
          lines: [{
            lineKey: "line-0001", productId: "product-17", variantId: "variant-9", quantity: 2,
            checkoutUnitPrice: "44.50", checkoutCurrency: "GBP", catalogueUnitPrice: "49.00",
            catalogueCurrency: "GBP", catalogueObservedAt: now.toISOString(), catalogueComparison: "DIFFERENT",
            checkoutPriceChange: "UNVERIFIABLE", reasonCodes: ["PRICE_CONTEXT_UNVERIFIED"],
          }],
          reasonCodes: [],
          currentMerchandiseSubtotal: { amountDecimal: "89.00", currency: "GBP" },
          completeness: "COMPLETE",
        })),
      };
      const service = new InitialOutreachAgentContextService({
        db,
        environment: "TEST",
        priceReconciliationService,
        now: () => now,
      });
      const context = await service.build({
        shopId, checkoutRecoveryId: recoveryId, outreachAttemptId: attemptId,
        signal: new AbortController().signal,
      });

      expect(context).toMatchObject({
        shopId, checkoutRecoveryId: recoveryId, outreachAttemptId: attemptId,
        environment: "TEST", platform: "SHOPIFY", mode: "AI_BEST_APPLICABLE",
        authorisedDiscountIds: [],
        basket: {
          currency: "GBP", subtotalMinor: 8_900, totalMinor: 10_900,
          generation: 4, items: [{ lineKey: "line-0001", productId: "product-17", variantId: "variant-9",
            categoryIds: ["category-outerwear"], collectionIds: ["collection-winter"], title: "Wool coat", quantity: 2 }],
        },
        platformInstructions: "Platform safety rules.", platformInstructionRevisionId: platformRevisionId,
        merchantInstructions: "Prefer winter outerwear.", merchantInstructionRevisionId: shopRevisionId,
      });
      expect(context.priceReconciliation).toMatchObject({
        shopId, checkoutRecoveryId: recoveryId, outreachAttemptId: attemptId,
        generation: context.basket.generation, basketFingerprint: context.basket.fingerprint,
        currentMerchandiseSubtotal: { amountDecimal: "89.00", currency: "GBP" },
      });
      expect(priceReconciliationService.reconcile).toHaveBeenCalledWith(expect.objectContaining({
        shopId, checkoutRecoveryId: recoveryId, outreachAttemptId: attemptId,
        expectedGeneration: 4, expectedBasketFingerprint: context.basket.fingerprint,
      }));
      expect(JSON.stringify(context)).not.toContain("must-not-enter-agent-context@example.test");

      await db.shopSettings.update({ where: { shopId }, data: { recoveryOfferMode: "NONE" } });
      priceReconciliationService.reconcile.mockClear();
      const noneContext = await service.build({
        shopId, checkoutRecoveryId: recoveryId, outreachAttemptId: attemptId,
        signal: new AbortController().signal,
      });
      expect(noneContext).toMatchObject({ mode: "NONE", priceReconciliation: null });
      expect(priceReconciliationService.reconcile).not.toHaveBeenCalled();
    } finally {
      // The runner owns a disposable database; published prompt revisions are immutable audit records.
      await db.$disconnect();
    }
  });
});