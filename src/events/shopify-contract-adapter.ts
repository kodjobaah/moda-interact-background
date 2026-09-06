import {
  parseShopifyRecoveryEventV2,
  type ShopifyRecoveryEventV2,
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
 * Runtime-validate worker job data against the canonical ARCH-001 v2 recovery
 * contract. Invalid cross-service payloads throw before any business handling
 * so malformed events fail visibly rather than being treated as valid.
 */
export function parseRuntimeShopifyEvent(
  jobData: unknown,
): ShopifyRecoveryEventV2 {
  return parseShopifyRecoveryEventV2(jobData);
}

export function mapCheckoutCreatedContractInput(
  event: ShopifyRecoveryEventV2,
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
  event: ShopifyRecoveryEventV2,
): CheckoutUpdatedContractInput {
  if (event.eventType !== "checkout.updated") {
      throw new Error(
      `Invalid checkout event type for checkout-updated handler: ${event.eventType}`,
      );
    }

    return {
    shopDomain: event.tenant.shopDomain,
    checkoutToken: event.payload.checkoutToken,
    ...(event.internationalContext
      ? { internationalContext: event.internationalContext }
      : {}),
    activityAt: event.occurredAt ?? event.receivedAt,
    };
  }

export function mapCartActivityContractInput(
  event: ShopifyRecoveryEventV2,
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
  event: ShopifyRecoveryEventV2,
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


