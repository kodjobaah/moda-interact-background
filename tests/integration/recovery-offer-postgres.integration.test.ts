import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { checkoutOfferFingerprint } from "../../src/services/recovery-offers/recovery-offer-evidence.js";
import { PrismaRecoveryOfferRepository } from "../../src/services/recovery-offers/recovery-offer-repository.js";
import { RecoveryOfferResolver } from "../../src/services/recovery-offers/recovery-offer-resolver.service.js";
import type { ReadOnlyProviderEligibility } from "../../src/services/recovery-offers/recovery-offer.types.js";

const integration = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;

integration("ARCH-047-BACKGROUND-004 tenant-scoped PostgreSQL offers", () => {
  it("only uses merchant-selected rows in its own shop and requires read-only checkout proof", async () => {
    const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
    const suffix = randomUUID();
    const shopId = `arch047-offer-${suffix}`;
    const otherShopId = `arch047-other-${suffix}`;
    const recoveryId = `arch047-recovery-${suffix}`;
    const otherRecoveryId = `arch047-other-recovery-${suffix}`;
    const discountId = `arch047-discount-${suffix}`;
    const now = new Date(Date.now() + 30_000);
    const expected = {
      shopId, checkoutRecoveryId: recoveryId, stage: "INITIAL" as const, now,
      policy: { recoveryOfferMode: "FIXED" as const,
        fixedShopifyDiscountId: discountId, offerSnapshot: null },
    };
    const logger = { warn: vi.fn(), error: vi.fn() };
    const approvedCheckoutReader: ReadOnlyProviderEligibility = {
      evaluate: vi.fn(async ({ shopId: verifiedShop, checkout, checkoutFingerprint, discount }) => ({
        outcome: "eligible", evidence: {
          shopId: verifiedShop, checkoutRecoveryId: checkout.id,
          providerDiscountId: discount.shopifyDiscountNodeId,
          checkoutFingerprint, evaluatedAt: now, expiresAt: new Date(now.getTime() + 30_000),
          currency: checkout.currency!, savingsMinor: 400,
          verifiedCode: discount.singleRedeemCode, verifiedDescription: "Fixed checkout offer",
          qualifies: true as const,
          verifiedConstraints: ["PROVIDER_RULES_CURRENT"],
        },
      })),
    };
    try {
      await db.shop.createMany({ data: [
        { id: shopId, domain: `${suffix}.shopify.test`, platform: "SHOPIFY", status: "ACTIVE" },
        { id: otherShopId, domain: `other-${suffix}.shopify.test`, platform: "SHOPIFY", status: "ACTIVE" },
      ] });
      await db.checkoutRecovery.createMany({ data: [
        { id: recoveryId, shopId, checkoutToken: `checkout-${suffix}`, status: "DETECTED",
          currency: "USD", totalPrice: "100.00", lineItems: [{ productId: "p1", quantity: 1 }],
          lastExternalActivityAt: new Date(now.getTime() - 15 * 60_000) },
        { id: otherRecoveryId, shopId: otherShopId, checkoutToken: `other-checkout-${suffix}`,
          status: "DETECTED", currency: "USD", totalPrice: "10.00", lineItems: [],
          lastExternalActivityAt: now },
      ] });
      await db.shopifyDiscountCatalogue.create({ data: {
        shopId, status: "CURRENT", lastSuccessfulSyncAt: new Date(now.getTime() - 60_000),
      } });
      await db.shopifyDiscount.create({ data: {
        id: discountId, shopId, shopifyDiscountNodeId: `gid://shopify/DiscountCodeNode/${suffix}`,
        providerType: "DiscountCodeBasic", method: "CODE", providerStatus: "ACTIVE",
        title: "Recovery savings", summary: "Fixed checkout offer", codeCount: 1,
        singleRedeemCode: "SAVE5", fixedSelectable: true, isAvailable: true,
        providerSnapshot: {}, lastSeenSyncGeneration: 1, lastSyncedAt: now,
      } });
      const reader = new PrismaRecoveryOfferRepository(db);
      const resolvedCheckout = await reader.readCheckout(shopId, recoveryId);
      expect(checkoutOfferFingerprint(resolvedCheckout!)).toMatch(/^[a-f0-9]{64}$/);
      expect(await reader.readCheckout(shopId, otherRecoveryId)).toBeNull();
      const resolver = new RecoveryOfferResolver(reader, approvedCheckoutReader, undefined,
        null, logger);
      // The default production adapter is deliberately unavailable until an
      // actual provider/Commerce eligibility reader is approved and connected.
      const defaultOnly = new RecoveryOfferResolver(reader, undefined, undefined,
        null, logger);
      expect(await defaultOnly.resolve(expected)).toMatchObject({
        kind: "NO_OFFER", reason: "PROVIDER_VERIFICATION_UNAVAILABLE",
      });
      expect(await resolver.resolve(expected)).toMatchObject({
        kind: "CODE_OFFER", checkoutRecoveryId: recoveryId,
        parameters: { code: "SAVE5" }, evidence: { savingsMinor: 400 },
      });
      expect(await resolver.resolve({ ...expected, checkoutRecoveryId: otherRecoveryId })).toMatchObject({
        kind: "NO_OFFER", reason: "RECOVERY_UNAVAILABLE",
      });
      expect(approvedCheckoutReader.evaluate).toHaveBeenCalledTimes(1);
      expect(await db.shopifyDiscount.count({ where: { shopId } })).toBe(1);
      expect(await db.checkoutRecovery.count({ where: { shopId } })).toBe(1);
    } finally {
      await db.shop.deleteMany({ where: { id: { in: [shopId, otherShopId] } } });
      await db.$disconnect();
    }
  }, 45_000);
});
