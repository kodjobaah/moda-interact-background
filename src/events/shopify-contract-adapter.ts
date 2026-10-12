import {
  parseShopifyRecoveryEvent,
  type ShopifyRecoveryEvent,
} from "@modainteract/moda-interact-shared/shopify";
import type { InternationalContext } from "@modainteract/moda-interact-shared/internationalization";

export type CheckoutCreatedContractInput = {
  shopDomain: string;
  checkoutToken: string;
  cartToken: string | null;
  checkoutCreatedAt: string | null;
  abandonedCheckoutUrl: string | null;
  internationalContext?: InternationalContext;
  activityAt?: string;
};

export type CheckoutUpdatedContractInput = {
  shopDomain: string;
  checkoutToken: string;
  cartToken?: string | null;
  checkoutCreatedAt?: string | null;
  abandonedCheckoutUrl?: string | null;
  internationalContext?: InternationalContext;
  activityAt: string;
};

export type CartActivityContractInput = {
  shopId: string;
  shopDomain: string;
  cartToken: string;
  isEmpty: boolean | null;
  activityAt: string;
};

export type OrderCompletedContractInput = {
  shopDomain: string;
  orderId: string;
  checkoutToken: string | null;
  cartToken: string | null;
  completedAt: string;
};

/**
 * Runtime-validate queued events against the canonical compatible v2/v3
 * Shopify contract. Invalid cross-service payloads fail before handling.
 */
export function parseRuntimeShopifyEvent(
  jobData: unknown,
): ShopifyRecoveryEvent {
  return parseShopifyRecoveryEvent(jobData);
}

export function mapCheckoutCreatedContractInput(
  event: ShopifyRecoveryEvent,
): CheckoutCreatedContractInput {
  if (event.eventType !== "checkout.created") {
      throw new Error(
      `Invalid checkout event type for checkout-created handler: ${event.eventType}`,
      );
    }

    return {
    shopDomain: event.tenant.shopDomain,
    checkoutToken: event.payload.checkoutToken,
    cartToken: event.payload.cartToken,
    checkoutCreatedAt: event.payload.checkoutCreatedAt,
    abandonedCheckoutUrl: event.payload.abandonedCheckoutUrl,
    ...(event.internationalContext
      ? { internationalContext: event.internationalContext }
      : {}),
    activityAt: event.occurredAt ?? event.receivedAt,
    };
  }

export function mapCheckoutUpdatedContractInput(
  event: ShopifyRecoveryEvent,
): CheckoutUpdatedContractInput {
  if (event.eventType !== "checkout.updated") {
      throw new Error(
      `Invalid checkout event type for checkout-updated handler: ${event.eventType}`,
      );
    }

    return {
    shopDomain: event.tenant.shopDomain,
    checkoutToken: event.payload.checkoutToken,
    ...( "cartToken" in event.payload && event.payload.cartToken !== undefined
      ? { cartToken: event.payload.cartToken }
      : {}),
    ...( "checkoutCreatedAt" in event.payload && event.payload.checkoutCreatedAt !== undefined
      ? { checkoutCreatedAt: event.payload.checkoutCreatedAt }
      : {}),
    ...( "abandonedCheckoutUrl" in event.payload && event.payload.abandonedCheckoutUrl !== undefined
      ? { abandonedCheckoutUrl: event.payload.abandonedCheckoutUrl }
      : {}),
    ...(event.internationalContext
      ? { internationalContext: event.internationalContext }
      : {}),
    activityAt: event.occurredAt ?? event.receivedAt,
    };
  }

export function mapCartActivityContractInput(
  event: ShopifyRecoveryEvent,
): CartActivityContractInput {
  if (event.eventType !== "cart.activity") {
      throw new Error(
      `Invalid event type for cart-activity handler: ${event.eventType}`,
      );
    }

    return {
    shopId: event.tenant.shopId,
    shopDomain: event.tenant.shopDomain,
    cartToken: event.payload.cartToken,
    isEmpty: event.payload.isEmpty,
    activityAt: event.occurredAt ?? event.receivedAt,
    };
  }

export function mapOrderCompletedContractInput(
  event: ShopifyRecoveryEvent,
): OrderCompletedContractInput {
  if (event.eventType !== "order.completed") {
      throw new Error(
      `Invalid event type for order-completed handler: ${event.eventType}`,
      );
    }

    return {
    shopDomain: event.tenant.shopDomain,
    orderId: event.payload.orderId,
    checkoutToken: event.payload.checkoutToken,
    cartToken: event.payload.cartToken,
    completedAt: event.payload.completedAt,
    };
  }


