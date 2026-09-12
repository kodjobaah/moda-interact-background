import { describe, expect, it, vi } from "vitest";

import { ShopifyPartnerBillingApi } from "../../../src/providers/shopify-partner-billing.provider.js";

const environment = {
  SHOPIFY_PARTNER_ORG_ID: "org-1",
  SHOPIFY_PARTNER_ACCESS_TOKEN: "token-1",
  SHOPIFY_APP_ID: "app-1",
};

const activeSubscription = {
  cancelAtEndOfCycle: false,
  billingPeriod: "EVERY_30_DAYS",
  trialEndsAt: null,
  currentBillingCycle: {
    startTime: "2026-09-01T00:00:00.000Z",
    endTime: "2026-10-01T00:00:00.000Z",
  },
  legacySubscriptionId: "legacy-current",
  items: [{
    handle: "growth-plan",
    description: "Growth plan",
    price: { __typename: "FlatRatePrice", active: true, currency: "USD", amount: "75.00" },
    usage: null,
  }],
  pendingUpdate: null,
};

function lifecycleEvent(
  state: string,
  eventType = `SUBSCRIPTION_${state}`,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "event-1",
    occurredAt: "2026-09-12T12:00:00.000Z",
    eventType,
    subject: {
      __typename: "SubscriptionStatus",
      state,
      appId: "app-1",
      shopId: "gid://shopify/Shop/1",
      cancelEffectiveOn: null,
      planHandle: "growth-plan",
      billingPeriod: "EVERY_30_DAYS",
      ...overrides,
    },
  };
}

function snapshotFetch(data: Record<string, unknown>, now = new Date("2026-09-12T12:00:00.000Z")) {
  const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data }) });
  const api = new ShopifyPartnerBillingApi(environment, fetchImpl as never, () => now);
  return { api, fetchImpl };
}

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
      environment,
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
      environment,
      fetchImpl as never,
    );

    await expect(api.getActiveSubscription("gid://shopify/Shop/1")).resolves.toBeNull();
  });

  it.each([
    ["CREATED", "SUBSCRIPTION_CREATED"],
    ["FROZEN", "SUBSCRIPTION_FROZEN"],
    ["CANCELED", "SUBSCRIPTION_CANCELED"],
    ["UNFROZEN", "SUBSCRIPTION_UNFROZEN"],
  ] as const)("parses the latest %s lifecycle event", async (state, eventType) => {
    const { api } = snapshotFetch({
      activeSubscription: state === "CANCELED" ? null : activeSubscription,
      events: { nodes: [lifecycleEvent(state, eventType)] },
    });

    await expect(api.getSubscriptionReconciliationSnapshot("gid://shopify/Shop/1")).resolves.toMatchObject({
      activeSubscription: { planHandle: "growth-plan" },
      latestLifecycleEvent: { eventType, state, occurredAt: new Date("2026-09-12T12:00:00.000Z") },
    });
  });

  it("keeps a frozen null subscription distinct from cancellation", async () => {
    const { api } = snapshotFetch({
      activeSubscription: null,
      events: { nodes: [lifecycleEvent("FROZEN", "SUBSCRIPTION_FROZEN")] },
    });

    await expect(api.getSubscriptionReconciliationSnapshot("gid://shopify/Shop/1")).resolves.toMatchObject({
      activeSubscription: null,
      latestLifecycleEvent: { state: "FROZEN" },
    });
  });

  it("parses cancellation effective date and returns null for no events", async () => {
    const { api: cancellationApi } = snapshotFetch({
      activeSubscription: null,
      events: {
        nodes: [lifecycleEvent("CANCELLATION_SCHEDULED", "SUBSCRIPTION_CANCELLATION_SCHEDULED", {
          cancelEffectiveOn: "2026-10-01",
        })],
      },
    });
    await expect(cancellationApi.getSubscriptionReconciliationSnapshot("gid://shopify/Shop/1")).resolves.toMatchObject({
      latestLifecycleEvent: { state: "CANCELLATION_SCHEDULED", cancelEffectiveOn: "2026-10-01" },
    });

    const { api: emptyApi } = snapshotFetch({ activeSubscription, events: { nodes: [] } });
    await expect(emptyApi.getSubscriptionReconciliationSnapshot("gid://shopify/Shop/1")).resolves.toMatchObject({
      latestLifecycleEvent: null,
    });
  });

  it("rejects HTTP and GraphQL failures", async () => {
    const httpFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const httpApi = new ShopifyPartnerBillingApi(environment, httpFetch as never);
    await expect(httpApi.getSubscriptionReconciliationSnapshot("shop-1")).rejects.toMatchObject({ code: "http-503" });

    const graphqlFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ errors: [{ message: "events unavailable" }] }),
    });
    const graphqlApi = new ShopifyPartnerBillingApi(environment, graphqlFetch as never);
    await expect(graphqlApi.getSubscriptionReconciliationSnapshot("shop-1")).rejects.toMatchObject({ code: "graphql-error" });
  });

  it("bounds and scopes the lifecycle query", async () => {
    const { api, fetchImpl } = snapshotFetch({ activeSubscription, events: { nodes: [] } });
    await api.getSubscriptionReconciliationSnapshot("gid://shopify/Shop/1");
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { query: string; variables: Record<string, unknown> };
    expect(body.query).toContain("subjectId: $appId");
    expect(body.query).toContain("shopId: $shopId");
    expect(body.query).toContain("occurredAtMin: $occurredAtMin");
    expect(body.query).toContain("occurredAtMax: $occurredAtMax");
    expect(body.variables).toMatchObject({
      appId: "app-1",
      shopId: "gid://shopify/Shop/1",
      occurredAtMin: "2025-09-12T12:00:00.000Z",
      occurredAtMax: "2026-09-12T12:00:00.000Z",
      eventTypes: [
        "SUBSCRIPTION_CREATED",
        "SUBSCRIPTION_UPDATED",
        "SUBSCRIPTION_CANCELLATION_SCHEDULED",
        "SUBSCRIPTION_CANCELED",
        "SUBSCRIPTION_FROZEN",
        "SUBSCRIPTION_UNFROZEN",
      ],
    });
  });

  it.each([
    { occurredAt: "not-a-date" },
    { eventType: "SUBSCRIPTION_FROZEN", subject: lifecycleEvent("FROZEN", "SUBSCRIPTION_FROZEN", { appId: "other-app" }).subject },
    { eventType: "SUBSCRIPTION_FROZEN", subject: lifecycleEvent("FROZEN", "SUBSCRIPTION_FROZEN", { state: "UNKNOWN" }).subject },
  ])("rejects malformed lifecycle event: %o", async (event) => {
    const { api } = snapshotFetch({ activeSubscription: null, events: { nodes: [{ ...lifecycleEvent("FROZEN", "SUBSCRIPTION_FROZEN"), ...event }] } });
    await expect(api.getSubscriptionReconciliationSnapshot("gid://shopify/Shop/1")).rejects.toMatchObject({ code: "malformed-lifecycle-event" });
  });

});