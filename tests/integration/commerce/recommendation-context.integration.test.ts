import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { CommerceTurnIdentitySchema } from "@modainteract/moda-interact-shared/commerce";
import { resolveCommerceEnvironment } from "../../../src/commerce/model-environment.js";
import { loadRecommendationContext, refreshRecommendationContext, refreshRecommendationPolicy } from "../../../src/commerce/recommendations/context.js";
import { CommerceHostError } from "../../../src/commerce/mcp-client.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

describeWithDatabase("recommendation context PostgreSQL boundary", () => {
  it("loads published prompts and current policy, then detects basket and policy changes", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const suffix = randomUUID();
    const shopId = `recommendation-${suffix}`;
    const recoveryId = `recovery-${suffix}`;
    const platformPromptId = `platform-prompt-${suffix}`;
    const shopPromptId = `shop-prompt-${suffix}`;
    const platformRevisionId = `platform-revision-${suffix}`;
    const shopRevisionId = `shop-revision-${suffix}`;
    const now = new Date("2026-11-05T12:00:00.000Z");
    const recovery = {
      id: recoveryId, shopId, generation: 3, currency: "GBP",
      lineItems: [{ productId: "product-1", variantId: "variant-1", title: "Wool coat", quantity: 2,
        categoryIds: ["outerwear"], collectionIds: ["winter"] }],
      shop: { platform: "SHOPIFY", domain: `${suffix}.myshopify.com` },
    };
    const turn = CommerceTurnIdentitySchema.parse({ contractVersion: "commerce.v1", shopId,
      checkoutRecoveryId: recoveryId, conversationId: `conversation-${suffix}`, inboundVersion: 1 });
    const assertCurrent = async () => undefined;
    try {
      await db.shop.create({ data: { id: shopId, domain: recovery.shop.domain, platform: "SHOPIFY", status: "ACTIVE" } });
      await db.shopSettings.create({ data: { shopId, recoveryOfferMode: "AI_BEST_APPLICABLE", fixedShopifyDiscountId: null } });
      await db.checkoutRecovery.create({ data: { id: recoveryId, shopId, checkoutToken: `token-${suffix}`,
        status: "DETECTED", generation: 3, currency: "GBP", totalPrice: "89.00", lineItems: recovery.lineItems,
        lastExternalActivityAt: now } });
      await db.commerceAgentPrompt.createMany({ data: [
        { id: platformPromptId, scope: "PLATFORM", shopId: null },
        { id: shopPromptId, scope: "SHOP", shopId },
      ] });
      await db.commerceAgentPromptRevision.createMany({ data: [
        { id: platformRevisionId, promptId: platformPromptId, revisionNumber: 1, status: "PUBLISHED",
          promptText: "Published platform guidance.", publishedAt: now },
        { id: shopRevisionId, promptId: shopPromptId, revisionNumber: 1, status: "PUBLISHED",
          promptText: "Published shop guidance.", publishedAt: now },
      ] });
      await db.commerceAgentConfiguration.createMany({ data: [
        { environment: resolveCommerceEnvironment(), scope: "PLATFORM", shopId: null, activePromptRevisionId: platformRevisionId },
        { environment: resolveCommerceEnvironment(), scope: "SHOP", shopId, activePromptRevisionId: shopRevisionId },
      ] });

      const context = await loadRecommendationContext({ recovery, turn,
        grant: { id: `grant-${suffix}`, releaseId: `release-${suffix}` }, db,
        environment: resolveCommerceEnvironment(), signal: new AbortController().signal, assertCurrent, now: () => now });
      expect(context).toMatchObject({ provider: "SHOPIFY", policy: { mode: "AI_BEST_APPLICABLE", authorisedDiscountIds: [] },
        platformText: "Published platform guidance.", shopText: "Published shop guidance.", basket: { generation: 3, currency: "GBP" } });

      await db.checkoutRecovery.update({ where: { id: recoveryId }, data: { generation: 4 } });
      const refreshed = await refreshRecommendationContext({ context, recoveryId, db,
        signal: new AbortController().signal, assertCurrent });
      expect(refreshed.basketChanged).toBe(true);
      await db.shopSettings.update({ where: { shopId }, data: { recoveryOfferMode: "NONE" } });
      await expect(refreshRecommendationPolicy({ context, db, signal: new AbortController().signal, assertCurrent }))
        .rejects.toBeInstanceOf(CommerceHostError);
    } finally {
      await db.commerceAgentConfiguration.deleteMany({ where: { shopId } });
      await db.commerceAgentPromptRevision.deleteMany({ where: { id: { in: [platformRevisionId, shopRevisionId] } } });
      await db.commerceAgentPrompt.deleteMany({ where: { id: { in: [platformPromptId, shopPromptId] } } });
      await db.checkoutRecovery.deleteMany({ where: { id: recoveryId } });
      await db.shopSettings.deleteMany({ where: { shopId } });
      await db.shop.deleteMany({ where: { id: shopId } });
      await db.$disconnect();
    }
  }, 30_000);
});
