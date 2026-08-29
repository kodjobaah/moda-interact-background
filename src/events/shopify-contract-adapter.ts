import {
  parseShopifyRecoveryEventV2,
  type ShopifyRecoveryEventV2,
} from "@modainteract/moda-interact-shared/shopify";

export type CheckoutCreatedContractInput = {
  shopDomain: string;
  checkoutToken: string;
  cartToken: string | null;
  checkoutCreatedAt: string | null;
  abandonedCheckoutUrl: string | null;
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


