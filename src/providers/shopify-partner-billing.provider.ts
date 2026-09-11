import {
  SHOPIFY_SUBSCRIPTION_CANCELLATION_ARGS,
  type SubscriptionCancellationMode,
} from "@modainteract/moda-interact-shared/billing";

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

export interface ShopifyPartnerBillingProvider {
  getActiveSubscription(shopifyShopId: string): Promise<PartnerSubscription | null>;
  cancelSubscription(input: {
    shopifyShopId: string;
    mode: SubscriptionCancellationMode;
  }): Promise<{ summary: string }>;
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

type CancellationResponse = {
  data?: {
    appSubscriptionCancel?: {
      appSubscription: { id: string } | null;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
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

const CANCEL_SUBSCRIPTION_MUTATION = `
  mutation CancelSubscription(
    $appId: ID!
    $shopId: ID!
    $deferCancellation: Boolean!
    $prorate: Boolean!
    $skipFinalUsageCharge: Boolean!
  ) {
    appSubscriptionCancel(
      appId: $appId
      shopId: $shopId
      deferCancellation: $deferCancellation
      prorate: $prorate
      skipFinalUsageCharge: $skipFinalUsageCharge
    ) {
      appSubscription { id }
      userErrors { field message }
    }
  }
`;

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
    const subscription = result.data?.activeSubscription;
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

  async cancelSubscription(input: {
    shopifyShopId: string;
    mode: SubscriptionCancellationMode;
  }): Promise<{ summary: string }> {
    const config = this.readConfig();
    const args = SHOPIFY_SUBSCRIPTION_CANCELLATION_ARGS[input.mode];
    if (!args) {
      throw new ShopifyPartnerBillingError("Unsupported subscription cancellation mode", "invalid-mode", false);
    }
    const response = await this.fetchImpl(
      `https://partners.shopify.com/${config.orgId}/api/2026-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": config.accessToken,
        },
        body: JSON.stringify({
          query: CANCEL_SUBSCRIPTION_MUTATION,
          variables: {
            appId: config.appId,
            shopId: input.shopifyShopId,
            ...args,
          },
        }),
      },
    );
    if (!response.ok) throw providerHttpError(response.status);
    const result = await response.json() as CancellationResponse;
    if (result.errors?.length) {
      throw new ShopifyPartnerBillingError(
        result.errors.map((error) => error.message).join(", ").slice(0, 2000),
        "graphql-error",
        true,
      );
    }
    const payload = result.data?.appSubscriptionCancel;
    if (!payload) {
      throw new ShopifyPartnerBillingError("Shopify Partner cancellation response was empty", "empty-response", true);
    }
    if (payload.userErrors.length > 0) {
      throw new ShopifyPartnerBillingError(
        payload.userErrors.map((error) => error.message).join(", ").slice(0, 2000),
        "user-error",
        false,
      );
    }
    return { summary: "Shopify Partner accepted appSubscriptionCancel" };
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

function providerHttpError(status: number): ShopifyPartnerBillingError {
  return new ShopifyPartnerBillingError(
    `Shopify Partner API request failed: ${status}`,
    `http-${status}`,
    [408, 409, 425, 429].includes(status) || status >= 500,
  );
}

export const shopifyPartnerBillingApi = new ShopifyPartnerBillingApi();