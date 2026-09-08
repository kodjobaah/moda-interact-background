import { describe, expect, it, vi } from "vitest";

import { ShopifyPartnerBillingApi } from "../../../src/providers/shopify-partner-billing.provider.js";

describe("ShopifyPartnerBillingApi", () => {
  it("mirrors the accepted Partner contract and classifies flat/tiered items independent of order", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          activeSubscription: {
            cancelAtEndOfCycle: false,
            billingPeriod: "EVERY_30_DAYS",
            trialEndsAt: null,
            currentBillingCycle: {
              startTime: "2026-09-01T00:00:00.000Z",
              endTime: "2026-10-01T00:00:00.000Z",
            },
            legacySubscriptionId: "legacy-current",
            items: [
              {
                handle: "recovery-meter",
                description: "Recovery conversations",
                price: {
                  __typename: "TieredPrice",
                  active: true,
                  currency: "USD",
                  tiersMode: "VOLUME",
                  tiers: [{ upTo: null, amountPerUnit: "0.05", amount: "0.05" }],
                },
                usage: { quantity: 3, cost: { amount: "0.15", currencyCode: "USD" } },
              },
              {
                handle: "growth-plan",
                description: "Growth plan",
                price: { __typename: "FlatRatePrice", active: true, currency: "USD", amount: "75.00" },
                usage: null,
              },
            ],
            pendingUpdate: {
              billingPeriod: "EVERY_30_DAYS",
              legacySubscriptionId: "legacy-pending",
              items: [{
                handle: "scale-plan",
                description: "Scale plan",
                price: { __typename: "FlatRatePrice", active: true, currency: "USD", amount: "149.00" },
              }],
            },
          },
        },
      }),
    });
    const api = new ShopifyPartnerBillingApi(
      {
        SHOPIFY_PARTNER_ORG_ID: "org-1",
        SHOPIFY_PARTNER_ACCESS_TOKEN: "token-1",
        SHOPIFY_APP_ID: "app-1",
      },
      fetchImpl as never,
    );

    await expect(api.getActiveSubscription("gid://shopify/Shop/1")).resolves.toMatchObject({
      planHandle: "growth-plan",
      usageEventHandles: ["recovery-meter"],
      pendingPlanHandle: "scale-plan",
      currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
    });
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { query: string };
    expect(body.query).toContain("billingPeriod");
    expect(body.query).toContain("pendingUpdate");
    expect(body.query).toContain("legacySubscriptionId");
    expect(body.query).toContain("currentBillingCycle");
    expect(body.query).toContain("items {\n        handle\n        description");
    expect(body.query).toContain("pendingUpdate {\n        billingPeriod\n        legacySubscriptionId");
  });

  it("represents a null active subscription as no contract", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { activeSubscription: null } }),
    });
    const api = new ShopifyPartnerBillingApi(
      { SHOPIFY_PARTNER_ORG_ID: "org-1", SHOPIFY_PARTNER_ACCESS_TOKEN: "token-1", SHOPIFY_APP_ID: "app-1" },
      fetchImpl as never,
    );

    await expect(api.getActiveSubscription("gid://shopify/Shop/1")).resolves.toBeNull();
  });
});