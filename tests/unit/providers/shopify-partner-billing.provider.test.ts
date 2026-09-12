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
  eventType = ({
    CREATED: "SUBSCRIPTION_CREATED",
    UPDATED: "SUBSCRIPTION_UPDATED",
    CANCELLATION_SCHEDULED: "SUBSCRIPTION_CANCELLATION_SCHEDULED",
    CANCELED: "SUBSCRIPTION_CANCELED",
    FROZEN: "SUBSCRIPTION_FROZEN",
    UNFROZEN: "SUBSCRIPTION_UNFROZEN",
  } as Record<string, string>)[state],
  overrides: Record<string, unknown> = {},
) {
  return {
    __typename: "SubscriptionStatus",
    id: "event-1",
    occurredAt: "2026-09-12T12:00:00.000Z",
    eventType,
    state,
    cancelEffectiveOn: null,
    plan: { handle: "growth-plan", billingPeriod: "EVERY_30_DAYS" },
    subject: { __typename: "AppReference", id: "app-1" },
    shop: { id: "gid://shopify/Shop/1" },
    ...overrides,
  };
}

function eventEdges(event: Record<string, unknown>) {
  return { edges: [{ node: event }] };
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
    ["UPDATED", "SUBSCRIPTION_UPDATED"],
    ["CANCELLATION_SCHEDULED", "SUBSCRIPTION_CANCELLATION_SCHEDULED"],
    ["FROZEN", "SUBSCRIPTION_FROZEN"],
    ["CANCELED", "SUBSCRIPTION_CANCELED"],
    ["UNFROZEN", "SUBSCRIPTION_UNFROZEN"],
  ] as const)("parses the latest %s lifecycle event", async (state, eventType) => {
    const { api } = snapshotFetch({
      activeSubscription: state === "CANCELED" ? null : activeSubscription,
      events: eventEdges(lifecycleEvent(state, eventType)),
    });

    await expect(api.getSubscriptionReconciliationSnapshot("gid://shopify/Shop/1")).resolves.toMatchObject({
      activeSubscription: state === "CANCELED" ? null : { planHandle: "growth-plan" },
      latestLifecycleEvent: {
        eventType,
        state,
        occurredAt: new Date("2026-09-12T12:00:00.000Z"),
        planHandle: "growth-plan",
        billingPeriod: "EVERY_30_DAYS",
      },
    });
  });

  it("keeps a frozen null subscription distinct from cancellation", async () => {
    const { api } = snapshotFetch({
      activeSubscription: null,
      events: eventEdges(lifecycleEvent("FROZEN", "SUBSCRIPTION_FROZEN")),
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
        edges: [{ node: lifecycleEvent("CANCELLATION_SCHEDULED", "SUBSCRIPTION_CANCELLATION_SCHEDULED", {
          cancelEffectiveOn: "2026-10-01",
        }) }],
      },
    });
    await expect(cancellationApi.getSubscriptionReconciliationSnapshot("gid://shopify/Shop/1")).resolves.toMatchObject({
      latestLifecycleEvent: { state: "CANCELLATION_SCHEDULED", cancelEffectiveOn: "2026-10-01" },
    });

    const { api: emptyApi } = snapshotFetch({ activeSubscription, events: { edges: [] } });
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
    const { api, fetchImpl } = snapshotFetch({ activeSubscription, events: { edges: [] } });
    await api.getSubscriptionReconciliationSnapshot("gid://shopify/Shop/1");
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { query: string; variables: Record<string, unknown> };
    expect(body.query).toContain("subjectId: $appId");
    expect(body.query).toContain("shopId: $shopId");
    expect(body.query).toContain("occurredAtMin: $occurredAtMin");
    expect(body.query).toContain("occurredAtMax: $occurredAtMax");
    expect(body.query).toContain("edges");
    expect(body.query).toContain("node {");
    expect(body.query).toContain("... on SubscriptionStatus");
    expect(body.query).toContain("... on AppReference { id }");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(body.query).toContain("activeSubscription(");
    expect(body.query).toContain("events(");
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
    { eventType: "SUBSCRIPTION_FROZEN", subject: { __typename: "AppReference", id: "other-app" } },
    { eventType: "SUBSCRIPTION_FROZEN", state: "UNKNOWN" },
    { eventType: "SUBSCRIPTION_CANCELED", state: "FROZEN" },
    { id: "   " },
  ])("rejects malformed lifecycle event: %o", async (event) => {
    const { api } = snapshotFetch({ activeSubscription: null, events: eventEdges({ ...lifecycleEvent("FROZEN", "SUBSCRIPTION_FROZEN"), ...event }) });
    await expect(api.getSubscriptionReconciliationSnapshot("gid://shopify/Shop/1")).rejects.toMatchObject({ code: "malformed-lifecycle-event" });
  });

  it.each([
    { __typename: "BillingEvent" },
    { __typename: "SubscriptionStatus", subject: { __typename: "ThemeReference", id: "theme-1" } },
    { __typename: "SubscriptionStatus", subject: { __typename: "AppReference", id: "app-1" }, shop: { id: "other-shop" } },
    { __typename: "SubscriptionStatus", plan: { handle: 123, billingPeriod: "EVERY_30_DAYS" } },
    { __typename: "SubscriptionStatus", plan: { handle: "growth-plan", billingPeriod: 123 } },
  ])("rejects malformed Partner event shape: %o", async (overrides) => {
    const { api } = snapshotFetch({
      activeSubscription: null,
      events: eventEdges({ ...lifecycleEvent("FROZEN", "SUBSCRIPTION_FROZEN"), ...overrides }),
    });
    await expect(api.getSubscriptionReconciliationSnapshot("gid://shopify/Shop/1")).rejects.toMatchObject({ code: "malformed-lifecycle-event" });
  });

  it("maps a null plan to null normalized plan fields", async () => {
    const { api } = snapshotFetch({
      activeSubscription: null,
      events: eventEdges(lifecycleEvent("UPDATED", "SUBSCRIPTION_UPDATED", { plan: null })),
    });
    await expect(api.getSubscriptionReconciliationSnapshot("gid://shopify/Shop/1")).resolves.toMatchObject({
      latestLifecycleEvent: { planHandle: null, billingPeriod: null },
    });
  });

  it("rejects missing event edges and missing requested roots", async () => {
    const { api: missingEdgesApi } = snapshotFetch({ activeSubscription: null, events: {} });
    await expect(missingEdgesApi.getSubscriptionReconciliationSnapshot("gid://shopify/Shop/1")).rejects.toMatchObject({ code: "malformed-response" });

    const { api: missingRootApi } = snapshotFetch({ events: { edges: [] } });
    await expect(missingRootApi.getSubscriptionReconciliationSnapshot("gid://shopify/Shop/1")).rejects.toMatchObject({ code: "malformed-response" });
  });

});