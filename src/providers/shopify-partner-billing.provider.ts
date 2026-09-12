export type PartnerUsageSnapshot = {
  handle: string;
  quantity: number | null;
  costAmount: string | null;
  costCurrency: string | null;
};

export type PartnerSubscription = {
  planHandle: string;
  usageEventHandles: string[];
  pendingPlanHandle: string | null;
  pendingEffectiveAt: Date | null;
  status: "ACTIVE" | "TRIALING";
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  providerSubscriptionId: string | null;
  providerUsageSnapshot: PartnerUsageSnapshot[];
};

export type PartnerSubscriptionLifecycleEvent = {
  id: string;
  eventType:
    | "SUBSCRIPTION_CREATED"
    | "SUBSCRIPTION_UPDATED"
    | "SUBSCRIPTION_CANCELLATION_SCHEDULED"
    | "SUBSCRIPTION_CANCELED"
    | "SUBSCRIPTION_FROZEN"
    | "SUBSCRIPTION_UNFROZEN";
  state: "CREATED" | "UPDATED" | "CANCELLATION_SCHEDULED" | "CANCELED" | "FROZEN" | "UNFROZEN";
  occurredAt: Date;
  cancelEffectiveOn: string | null;
  planHandle: string | null;
  billingPeriod: string | null;
};

export type PartnerSubscriptionReconciliationSnapshot = {
  activeSubscription: PartnerSubscription | null;
  latestLifecycleEvent: PartnerSubscriptionLifecycleEvent | null;
};

export interface ShopifyPartnerBillingProvider {
  getActiveSubscription(shopifyShopId: string): Promise<PartnerSubscription | null>;
  getSubscriptionReconciliationSnapshot(shopifyShopId: string): Promise<PartnerSubscriptionReconciliationSnapshot>;
}

export class ShopifyPartnerBillingError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ShopifyPartnerBillingError";
  }
}

type ShopifyPrice =
  | { __typename: "FlatRatePrice"; active: boolean; currency: string | null; amount: string }
  | { __typename: "TieredPrice"; active: boolean; currency: string | null; tiersMode: string; tiers: Array<{ upTo: number | null; amountPerUnit: string; amount: string }> };

type PartnerResponse = {
  data?: {
    activeSubscription: {
      cancelAtEndOfCycle: boolean;
      billingPeriod: string;
      trialEndsAt: string | null;
      currentBillingCycle: { startTime: string; endTime: string } | null;
      legacySubscriptionId: string | null;
      items: Array<{
        handle: string | null;
        description: string | null;
        price: ShopifyPrice | null;
        usage: { quantity: number | null; cost: { amount: string; currencyCode: string } | null } | null;
      }>;
      pendingUpdate: {
        billingPeriod: string | null;
        legacySubscriptionId: string | null;
        items: Array<{ handle: string | null; price: ShopifyPrice | null }>;
      } | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
};

const ACTIVE_SUBSCRIPTION_QUERY = `
  query ActiveSubscription($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      cancelAtEndOfCycle
      billingPeriod
      trialEndsAt
      currentBillingCycle { startTime endTime }
      legacySubscriptionId
      items {
        handle
        description
        price {
          __typename
          active
          currency
          ... on FlatRatePrice { amount }
          ... on TieredPrice { tiersMode tiers { upTo amountPerUnit amount } }
        }
        usage { quantity cost { amount currencyCode } }
      }
      pendingUpdate {
        billingPeriod
        legacySubscriptionId
        items {
          handle
          price {
            __typename
            active
            currency
            ... on FlatRatePrice { amount }
            ... on TieredPrice { tiersMode tiers { upTo amountPerUnit amount } }
          }
        }
      }
    }
  }
`;

const SUBSCRIPTION_RECONCILIATION_SNAPSHOT_QUERY = `
  query SubscriptionReconciliationSnapshot(
    $appId: ID!
    $shopId: ID!
    $occurredAtMin: DateTime!
    $occurredAtMax: DateTime!
    $eventTypes: [EventType!]
  ) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      cancelAtEndOfCycle
      billingPeriod
      trialEndsAt
      currentBillingCycle { startTime endTime }
      legacySubscriptionId
      items {
        handle
        description
        price {
          __typename
          active
          currency
          ... on FlatRatePrice { amount }
          ... on TieredPrice { tiersMode tiers { upTo amountPerUnit amount } }
        }
        usage { quantity cost { amount currencyCode } }
      }
      pendingUpdate {
        billingPeriod
        legacySubscriptionId
        items {
          handle
          price {
            __typename
            active
            currency
            ... on FlatRatePrice { amount }
            ... on TieredPrice { tiersMode tiers { upTo amountPerUnit amount } }
          }
        }
      }
    }
    events(
      first: 1
      filter: {
        subjectId: $appId
        shopId: $shopId
        eventTypes: $eventTypes
        occurredAtMin: $occurredAtMin
        occurredAtMax: $occurredAtMax
      }
      orderBy: OCCURRED_AT_DESC
    ) {
      edges {
        node {
          __typename
          id
          occurredAt
          eventType
          shop { id }
          subject {
            __typename
            ... on AppReference { id }
          }
          ... on SubscriptionStatus {
            state
            cancelEffectiveOn
            plan { handle billingPeriod }
          }
        }
      }
    }
  }
`;

const LIFECYCLE_EVENT_TYPES = [
  "SUBSCRIPTION_CREATED",
  "SUBSCRIPTION_UPDATED",
  "SUBSCRIPTION_CANCELLATION_SCHEDULED",
  "SUBSCRIPTION_CANCELED",
  "SUBSCRIPTION_FROZEN",
  "SUBSCRIPTION_UNFROZEN",
] as const;

type SubscriptionReconciliationResponse = PartnerResponse & {
  data?: PartnerResponse["data"] & {
    events?: { edges?: unknown[] };
  };
};

export class ShopifyPartnerBillingApi implements ShopifyPartnerBillingProvider {
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getActiveSubscription(shopifyShopId: string): Promise<PartnerSubscription | null> {
    const config = this.readConfig();

    const response = await this.fetchImpl(
      `https://partners.shopify.com/${config.orgId}/api/2026-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": config.accessToken,
        },
        body: JSON.stringify({
          query: ACTIVE_SUBSCRIPTION_QUERY,
          variables: { appId: config.appId, shopId: shopifyShopId },
        }),
      },
    );
    if (!response.ok) throw providerHttpError(response.status);

    const result = await response.json() as PartnerResponse;
    if (result.errors?.length) throw new ShopifyPartnerBillingError(
      result.errors.map((error) => error.message).join(", ").slice(0, 2000),
      "graphql-error",
      true,
    );
    return this.parseActiveSubscription(result.data?.activeSubscription ?? null);
  }

  async getSubscriptionReconciliationSnapshot(shopifyShopId: string): Promise<PartnerSubscriptionReconciliationSnapshot> {
    const config = this.readConfig();
    const occurredAtMax = this.now();
    const occurredAtMin = new Date(occurredAtMax.getTime() - 365 * 24 * 60 * 60 * 1000);

    const response = await this.fetchImpl(
      `https://partners.shopify.com/${config.orgId}/api/2026-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": config.accessToken,
        },
        body: JSON.stringify({
          query: SUBSCRIPTION_RECONCILIATION_SNAPSHOT_QUERY,
          variables: {
            appId: config.appId,
            shopId: shopifyShopId,
            occurredAtMin: occurredAtMin.toISOString(),
            occurredAtMax: occurredAtMax.toISOString(),
            eventTypes: LIFECYCLE_EVENT_TYPES,
          },
        }),
      },
    );
    if (!response.ok) throw providerHttpError(response.status);

    const result = await response.json() as SubscriptionReconciliationResponse;
    if (result.errors?.length) throw new ShopifyPartnerBillingError(
      result.errors.map((error) => error.message).join(", ").slice(0, 2000),
      "graphql-error",
      true,
    );
    if (!result.data
      || !Object.prototype.hasOwnProperty.call(result.data, "activeSubscription")
      || !result.data.events
      || !Array.isArray(result.data.events.edges)) {
      throw new ShopifyPartnerBillingError("Shopify Partner API returned a malformed reconciliation snapshot", "malformed-response", true);
    }

    return {
      activeSubscription: this.parseActiveSubscription(result.data.activeSubscription ?? null),
      latestLifecycleEvent: result.data.events.edges.length === 0
        ? null
        : parseLifecycleEvent(result.data.events.edges[0], config.appId, shopifyShopId),
    };
  }

  private parseActiveSubscription(subscription: NonNullable<PartnerResponse["data"]>["activeSubscription"] | null): PartnerSubscription | null {
    if (!subscription) return null;

    const flatRateItems = subscription.items.filter(
      (item) => item.handle && item.price?.__typename === "FlatRatePrice" && item.price.active,
    );
    if (flatRateItems.length !== 1 || !flatRateItems[0]?.handle) {
      throw new Error("Active Shopify subscription must have exactly one active flat-rate plan handle");
    }
    const pendingFlatRateItems = subscription.pendingUpdate?.items.filter(
      (item) => item.handle && item.price?.__typename === "FlatRatePrice" && item.price.active,
    ) ?? [];
    if (pendingFlatRateItems.length > 1) {
      throw new Error("Pending Shopify subscription update has multiple active flat-rate plan handles");
    }

    const trialEndsAt = subscription.trialEndsAt ? new Date(subscription.trialEndsAt) : null;
    const currentPeriodStart = subscription.currentBillingCycle
      ? new Date(subscription.currentBillingCycle.startTime)
      : null;
    const currentPeriodEnd = subscription.currentBillingCycle
      ? new Date(subscription.currentBillingCycle.endTime)
      : null;
    const tieredItems = subscription.items.filter(
      (item) => item.handle && item.price?.__typename === "TieredPrice" && item.price.active,
    );

    return {
      planHandle: flatRateItems[0].handle,
      usageEventHandles: tieredItems.flatMap((item) => item.handle ? [item.handle] : []),
      pendingPlanHandle: pendingFlatRateItems[0]?.handle ?? null,
      pendingEffectiveAt: pendingFlatRateItems[0] ? currentPeriodEnd : null,
      status: trialEndsAt && trialEndsAt > this.now() ? "TRIALING" : "ACTIVE",
      currentPeriodStart,
      currentPeriodEnd,
      trialEndsAt,
      cancelAtPeriodEnd: subscription.cancelAtEndOfCycle,
      providerSubscriptionId: subscription.legacySubscriptionId,
      providerUsageSnapshot: tieredItems.flatMap((item) => item.handle ? [{
        handle: item.handle,
        quantity: item.usage?.quantity ?? null,
        costAmount: item.usage?.cost?.amount ?? null,
        costCurrency: item.usage?.cost?.currencyCode ?? null,
      }] : []),
    };
  }

  private readConfig(): { orgId: string; accessToken: string; appId: string } {
    const orgId = this.environment.SHOPIFY_PARTNER_ORG_ID?.trim();
    const accessToken = this.environment.SHOPIFY_PARTNER_ACCESS_TOKEN?.trim();
    const appId = this.environment.SHOPIFY_APP_ID?.trim();
    if (!orgId || !accessToken || !appId) {
      throw new ShopifyPartnerBillingError("Shopify Partner API configuration is missing", "configuration-missing", false);
    }
    return { orgId, accessToken, appId };
  }
}

function parseLifecycleEvent(value: unknown, appId: string, shopId: string): PartnerSubscriptionLifecycleEvent {
  if (!isRecord(value)
    || !isRecord(value.node)) {
    throw new ShopifyPartnerBillingError("Shopify Partner API returned a malformed subscription lifecycle event", "malformed-lifecycle-event", true);
  }
  const event = value.node;
  if (event.__typename !== "SubscriptionStatus"
    || typeof event.id !== "string"
    || event.id.trim().length === 0
    || typeof event.occurredAt !== "string"
    || typeof event.eventType !== "string"
    || !isRecord(event.subject)
    || !isRecord(event.shop)) {
    throw new ShopifyPartnerBillingError("Shopify Partner API returned a non-SubscriptionStatus lifecycle event", "malformed-lifecycle-event", true);
  }
  if (event.subject.__typename !== "AppReference"
    || event.subject.id !== appId
    || event.shop.id !== shopId) {
    throw new ShopifyPartnerBillingError("Shopify Partner API returned a lifecycle event for a different app or shop", "malformed-lifecycle-event", true);
  }
  const occurredAt = new Date(event.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new ShopifyPartnerBillingError("Shopify Partner API returned an invalid lifecycle event timestamp", "malformed-lifecycle-event", true);
  }
  const state = event.state;
  const eventType = lifecycleEventType(state, event.eventType);
  if (!eventType) {
    throw new ShopifyPartnerBillingError("Shopify Partner API returned an invalid subscription lifecycle state", "malformed-lifecycle-event", true);
  }
  if (event.plan !== null && event.plan !== undefined && !isRecord(event.plan)) {
    throw new ShopifyPartnerBillingError("Shopify Partner API returned an invalid lifecycle plan", "malformed-lifecycle-event", true);
  }

  return {
    id: event.id,
    eventType,
    state,
    occurredAt,
    cancelEffectiveOn: nullableString(event.cancelEffectiveOn, "cancelEffectiveOn"),
    planHandle: nullableString(event.plan?.handle, "planHandle"),
    billingPeriod: nullableString(event.plan?.billingPeriod, "billingPeriod"),
  };
}

function lifecycleEventType(
  state: unknown,
  rawEventType: unknown,
): PartnerSubscriptionLifecycleEvent["eventType"] | null {
  const stateToEventType: Record<string, PartnerSubscriptionLifecycleEvent["eventType"]> = {
    CREATED: "SUBSCRIPTION_CREATED",
    UPDATED: "SUBSCRIPTION_UPDATED",
    CANCELLATION_SCHEDULED: "SUBSCRIPTION_CANCELLATION_SCHEDULED",
    CANCELED: "SUBSCRIPTION_CANCELED",
    FROZEN: "SUBSCRIPTION_FROZEN",
    UNFROZEN: "SUBSCRIPTION_UNFROZEN",
  };
  if (typeof state !== "string" || !(state in stateToEventType)) return null;
  const expected = stateToEventType[state];
  if (!expected || rawEventType !== expected) return null;
  return expected;
}

function nullableString(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new ShopifyPartnerBillingError(
      `Shopify Partner API returned an invalid lifecycle ${fieldName}`,
      "malformed-lifecycle-event",
      true,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function providerHttpError(status: number): ShopifyPartnerBillingError {
  return new ShopifyPartnerBillingError(
    `Shopify Partner API request failed: ${status}`,
    `http-${status}`,
    [408, 409, 425, 429].includes(status) || status >= 500,
  );
}

export const shopifyPartnerBillingApi = new ShopifyPartnerBillingApi();