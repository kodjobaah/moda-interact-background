import { describe, expect, it, vi } from "vitest";
import { PrismaConversationWrapperReadRepository } from "../../../../src/services/conversation-wrappers/repository.js";
import { buildWooRecoveryUrl, generateWooRecoveryToken, prepareWooRecoveryLink } from "../../../../src/services/woocommerce-recovery/woo-recovery-link-issuer.js";

describe("Woo recovery URL template binding", () => {
  const now = new Date("2026-10-30T16:00:00.000Z");

  function repository(checkoutUrl: string, lastExternalActivityAt = new Date(now.getTime() - 60_000),
    lifetimeDays: unknown = 21) {
    const shop = { id: "shop-1", domain: "https://shop.example.com", status: "ACTIVE",
      defaultLanguageTag: "en-GB", brand: null };
    const customer = { id: "customer-1", shopId: shop.id, firstName: null };
    const recovery = { id: "recovery-1", shopId: shop.id, customerId: customer.id, checkoutUrl, status: "DETECTED",
      expiredAt: null, lastExternalActivityAt, shop, customer };
    const db = { conversation: { findUnique: async () => ({ id: "conversation-1", shopId: shop.id,
      customerId: customer.id, languageTag: "en-GB", shop, customer, checkoutRecovery: recovery }) },
    backgroundRuntimeConfig: { findUnique: async () => ({ checkoutRecoveryLifetimeDays: lifetimeDays }) } };
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

  it.each([6 * 60_000, 8 * 24 * 60 * 60_000])(
    "allows a checkout URL aged %i milliseconds while within the persisted 21-day lifetime",
    async (ageMs) => {
    const plan = prepareWooRecoveryLink("https://shop.example.com/store", "shop.example.com");
    if (plan.kind !== "ready") throw new Error("expected verified merchant URL");
    const url = buildWooRecoveryUrl(plan, "recovery-1", generateWooRecoveryToken());
    const context = await repository(url, new Date(now.getTime() - ageMs))
      .loadContext("conversation-1");
    expect(context).toMatchObject({ checkoutAvailable: true, variables: { "checkout.url": url } });
    },
  );

  it("denies the exact configured cutoff and immediately denies a zero-day lifetime", async () => {
    const plan = prepareWooRecoveryLink("https://shop.example.com/store", "shop.example.com");
    if (plan.kind !== "ready") throw new Error("expected verified merchant URL");
    const url = buildWooRecoveryUrl(plan, "recovery-1", generateWooRecoveryToken());
    const cutoff = new Date(now.getTime() - 21 * 86_400_000);
    expect(await repository(url, cutoff).loadContext("conversation-1"))
      .toMatchObject({ checkoutAvailable: false, variables: {} });
    expect(await repository(url, now, 0).loadContext("conversation-1"))
      .toMatchObject({ checkoutAvailable: false, variables: {} });
    expect(await repository(url, new Date(cutoff.getTime() + 1)).loadContext("conversation-1"))
      .toMatchObject({ checkoutAvailable: true, variables: { "checkout.url": url } });
    expect(await repository(url, new Date(now.getTime() + 1)).loadContext("conversation-1"))
      .toMatchObject({ checkoutAvailable: false, variables: {} });
  });

  it.each([null, -1, 1.5])("fails closed for invalid persisted lifetime %s", async (lifetimeDays) => {
    const context = await repository("https://shop.example.com/checkout", undefined, lifetimeDays)
      .loadContext("conversation-1");
    expect(context).toMatchObject({ checkoutAvailable: false, variables: {} });
  });

  it("propagates unexpected policy reads after logging bounded context", async () => {
    const failure = new Error("database unavailable");
    const logger = { warn: vi.fn(), error: vi.fn() };
    const db = {
      conversation: { findUnique: async () => ({ id: "conversation-1", shopId: "shop-1",
        customerId: "customer-1", languageTag: "en-GB", shop: { id: "shop-1",
          domain: "shop.example.com", status: "ACTIVE", defaultLanguageTag: "en-GB", brand: null },
        customer: { id: "customer-1", shopId: "shop-1", firstName: null },
        checkoutRecovery: { id: "recovery-1", shopId: "shop-1", customerId: "customer-1",
          checkoutUrl: "https://shop.example.com/checkout", status: "DETECTED", expiredAt: null,
          lastExternalActivityAt: new Date(now.getTime() - 1_000), shop: null, customer: null } }) },
      backgroundRuntimeConfig: { findUnique: async () => { throw failure; } },
    };
    const repo = new PrismaConversationWrapperReadRepository(db as never, () => now, undefined, logger as never);
    await expect(repo.loadContext("conversation-1")).rejects.toBe(failure);
    expect(logger.error).toHaveBeenCalledWith("conversation_wrapper.checkout_lifetime.read_failed",
      expect.objectContaining({ conversationId: "conversation-1", shopId: "shop-1",
        recoveryId: "recovery-1", error: failure }));
  });
});
