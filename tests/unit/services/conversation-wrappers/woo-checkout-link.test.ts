import { describe, expect, it } from "vitest";
import { PrismaConversationWrapperReadRepository } from "../../../../src/services/conversation-wrappers/repository.js";
import { buildWooRecoveryUrl, generateWooRecoveryToken, prepareWooRecoveryLink } from "../../../../src/services/woocommerce-recovery/woo-recovery-link-issuer.js";

describe("Woo recovery URL template binding", () => {
  const now = new Date("2026-10-30T16:00:00.000Z");

  function repository(checkoutUrl: string, lastExternalActivityAt = new Date(now.getTime() - 60_000)) {
    const shop = { id: "shop-1", domain: "https://shop.example.com", status: "ACTIVE",
      defaultLanguageTag: "en-GB", brand: null };
    const customer = { id: "customer-1", shopId: shop.id, firstName: null };
    const recovery = { shopId: shop.id, customerId: customer.id, checkoutUrl, status: "DETECTED",
      expiredAt: null, lastExternalActivityAt, shop, customer };
    const db = { conversation: { findUnique: async () => ({ id: "conversation-1", shopId: shop.id,
      customerId: customer.id, languageTag: "en-GB", shop, customer, checkoutRecovery: recovery }) } };
    return new PrismaConversationWrapperReadRepository(db as never, () => now);
  }

  it("passes a verified generation URL through checkout.url and retains the existing freshness gate", async () => {
    const plan = prepareWooRecoveryLink("https://shop.example.com/store", "shop.example.com");
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;
    const url = buildWooRecoveryUrl(plan, "recovery-1", generateWooRecoveryToken());

    const context = await repository(url).loadContext("conversation-1");
    expect(context).toMatchObject({ checkoutAvailable: true,
      variables: { "checkout.url": url } });
  });

  it("does not bind a generation URL whose host differs from the merchant", async () => {
    const context = await repository("https://other.example.com/?moda_interact_resume=1&r=r&t=opaque")
      .loadContext("conversation-1");
    expect(context).toMatchObject({ checkoutAvailable: false, variables: {} });
  });

  it("keeps the existing seven-day recovery freshness limit", async () => {
    const plan = prepareWooRecoveryLink("https://shop.example.com/store", "shop.example.com");
    if (plan.kind !== "ready") throw new Error("expected verified merchant URL");
    const url = buildWooRecoveryUrl(plan, "recovery-1", generateWooRecoveryToken());
    const context = await repository(url, new Date(now.getTime() - 8 * 24 * 60 * 60_000))
      .loadContext("conversation-1");
    expect(context).toMatchObject({ checkoutAvailable: false, variables: {} });
  });
});
