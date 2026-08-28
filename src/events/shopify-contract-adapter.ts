import {
  parseShopifyRecoveryEventV2,
  safeParseShopifyRecoveryEventV2,
  parseShopifyCommerceEvent,
  type ShopifyRecoveryEventV2,
  type ShopifyCommerceEvent,
} from "@modainteract/moda-interact-shared/shopify";

type LegacyCheckoutCreatedTransitionEvent = {
  checkoutToken: string;
  cartToken: string | null;
  checkoutCreatedAt: string | null;
  abandonedCheckoutUrl: string | null;
};

type RuntimeShopifyEvent =
  | { kind: "v2"; event: ShopifyRecoveryEventV2 }
  | { kind: "v1"; event: ShopifyCommerceEvent };

export type CheckoutCreatedContractInput = {
  shopDomain: string;
  checkoutToken: string;
  cartToken: string | null;
  checkoutCreatedAt: string | null;
  abandonedCheckoutUrl: string | null;
  legacyV1Transition: LegacyCheckoutCreatedTransitionEvent | null;
};

export type CheckoutUpdatedContractInput = {
  shopDomain: string;
  checkoutToken: string;
};

export type OrderCompletedContractInput = {
  shopDomain: string;
  orderId: string;
  checkoutToken: string | null;
  cartToken: string | null;
  completedAt: string;
};

export function parseRuntimeShopifyEvent(jobData: unknown): RuntimeShopifyEvent {
  const v2Result = safeParseShopifyRecoveryEventV2(jobData);
  if (v2Result.success) {
    return { kind: "v2", event: v2Result.data };
  }

  return { kind: "v1", event: parseShopifyCommerceEvent(jobData) };
}

export function mapCheckoutCreatedContractInput(
  event: RuntimeShopifyEvent,
): CheckoutCreatedContractInput {
  if (event.kind === "v2") {
    if (event.event.eventType !== "checkout.created") {
      throw new Error(
        `Invalid checkout event type for checkout-created handler: ${event.event.eventType}`,
      );
    }

    return {
      shopDomain: event.event.tenant.shopDomain,
      checkoutToken: event.event.payload.checkoutToken,
      cartToken: event.event.payload.cartToken,
      checkoutCreatedAt: event.event.payload.checkoutCreatedAt,
      abandonedCheckoutUrl: event.event.payload.abandonedCheckoutUrl,
      legacyV1Transition: null,
    };
  }

  if (event.event.eventType !== "checkout.observed") {
    throw new Error(
      `Invalid legacy event type for checkout-created handler: ${event.event.eventType}`,
    );
  }

  return {
    shopDomain: event.event.tenant.shopDomain,
    checkoutToken: event.event.payload.checkoutToken,
    cartToken: event.event.payload.cartToken,
    checkoutCreatedAt: event.event.payload.checkoutCreatedAt,
    abandonedCheckoutUrl: null,
    // Transitional mapping keeps only correlation identifiers from legacy events.
    legacyV1Transition: {
      checkoutToken: event.event.payload.checkoutToken,
      cartToken: event.event.payload.cartToken,
      checkoutCreatedAt: event.event.payload.checkoutCreatedAt,
      abandonedCheckoutUrl: null,
    },
  };
}

export function mapCheckoutUpdatedContractInput(
  event: RuntimeShopifyEvent,
): CheckoutUpdatedContractInput {
  if (event.kind === "v2") {
    if (event.event.eventType !== "checkout.updated") {
      throw new Error(
        `Invalid checkout event type for checkout-updated handler: ${event.event.eventType}`,
      );
    }

    return {
      shopDomain: event.event.tenant.shopDomain,
      checkoutToken: event.event.payload.checkoutToken,
    };
  }

  if (event.event.eventType !== "checkout.observed") {
    throw new Error(
      `Invalid legacy event type for checkout-updated handler: ${event.event.eventType}`,
    );
  }

  return {
    shopDomain: event.event.tenant.shopDomain,
    checkoutToken: event.event.payload.checkoutToken,
  };
}

export function mapOrderCompletedContractInput(
  event: RuntimeShopifyEvent,
): OrderCompletedContractInput {
  if (event.kind === "v2") {
    if (event.event.eventType !== "order.completed") {
      throw new Error(
        `Invalid event type for order-completed handler: ${event.event.eventType}`,
      );
    }

    return {
      shopDomain: event.event.tenant.shopDomain,
      orderId: event.event.payload.orderId,
      checkoutToken: event.event.payload.checkoutToken,
      cartToken: event.event.payload.cartToken,
      completedAt: event.event.payload.completedAt,
    };
  }

  if (event.event.eventType !== "order.completed") {
    throw new Error(
      `Invalid legacy event type for order-completed handler: ${event.event.eventType}`,
    );
  }

  return {
    shopDomain: event.event.tenant.shopDomain,
    orderId: event.event.payload.orderId,
    checkoutToken: event.event.payload.checkoutToken,
    cartToken: null,
    completedAt: event.event.payload.completedAt,
  };
}
