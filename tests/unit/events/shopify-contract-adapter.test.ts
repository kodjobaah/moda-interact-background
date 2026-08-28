import { describe, expect, it } from "vitest";
import {
  mapCheckoutCreatedContractInput,
  mapCheckoutUpdatedContractInput,
  mapOrderCompletedContractInput,
  parseRuntimeShopifyEvent,
} from "../../../src/events/shopify-contract-adapter.js";

describe("shopify-contract-adapter", () => {
  it("parses and maps a valid v2 checkout.created event", () => {
    const parsed = parseRuntimeShopifyEvent({
      schemaVersion: 2,
      receiptId: "r1",
      deliveryId: "d1",
      eventId: "e1",
      source: "shopify",
      providerTopic: "CHECKOUTS_CREATE",
      tenant: { shopId: "shop_1", shopDomain: "shop.myshopify.com" },
      occurredAt: "2026-08-28T00:00:00.000Z",
      receivedAt: "2026-08-28T00:00:01.000Z",
      traceId: "t1",
      orderingKey: "shop_1:checkout_1",
      eventType: "checkout.created",
      payload: {
        checkoutToken: "checkout_1",
        cartToken: "cart_1",
        abandonedCheckoutUrl: "https://shop.example/recover",
        checkoutCreatedAt: "2026-08-28T00:00:00Z",
      },
    });

    const mapped = mapCheckoutCreatedContractInput(parsed);

    expect(mapped).toEqual({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_1",
      cartToken: "cart_1",
      abandonedCheckoutUrl: "https://shop.example/recover",
      checkoutCreatedAt: "2026-08-28T00:00:00Z",
      legacyV1Transition: null,
    });
  });

  it("falls back to v1 parsing and marks transition payload without basket authority", () => {
    const parsed = parseRuntimeShopifyEvent({
      schemaVersion: 1,
      receiptId: "r1",
      deliveryId: "d1",
      eventId: "e1",
      source: "shopify",
      providerTopic: "CHECKOUTS_CREATE",
      tenant: { shopId: "shop_1", shopDomain: "shop.myshopify.com" },
      occurredAt: "2026-08-28T00:00:00.000Z",
      receivedAt: "2026-08-28T00:00:01.000Z",
      traceId: "t1",
      orderingKey: "shop_1:checkout_1",
      eventType: "checkout.observed",
      payload: {
        checkoutToken: "checkout_1",
        cartToken: "cart_1",
        checkoutUrl: "https://shop.example/checkout",
        customer: {
          shopifyCustomerId: "gid://shopify/Customer/1",
          phone: "+15550001111",
          email: "customer@example.com",
          firstName: "Ada",
          lastName: "Lovelace",
        },
        total: { amount: "10.00", currencyCode: "USD" },
        lineItems: [
          {
            lineItemId: "li_1",
            productId: "p_1",
            variantId: "v_1",
            title: "Ignored Item",
            variantTitle: null,
            sku: null,
            quantity: 1,
            unitPrice: "10.00",
          },
        ],
        checkoutCreatedAt: "2026-08-28T00:00:00Z",
        checkoutUpdatedAt: null,
        completedAt: null,
      },
    });

    const mapped = mapCheckoutCreatedContractInput(parsed);

    expect(mapped.checkoutToken).toBe("checkout_1");
    expect(mapped.cartToken).toBe("cart_1");
    expect(mapped.abandonedCheckoutUrl).toBeNull();
    expect(mapped.legacyV1Transition).not.toBeNull();
  });

  it("throws on invalid cross-service payload", () => {
    expect(() =>
      parseRuntimeShopifyEvent({
        not: "a-shopify-event",
      }),
    ).toThrow();
  });

  it("maps checkout.updated and order.completed from v2", () => {
    const updatedMapped = mapCheckoutUpdatedContractInput(
      parseRuntimeShopifyEvent({
        schemaVersion: 2,
        receiptId: "r2",
        deliveryId: "d2",
        eventId: "e2",
        source: "shopify",
        providerTopic: "CHECKOUTS_UPDATE",
        tenant: { shopId: "shop_1", shopDomain: "shop.myshopify.com" },
        occurredAt: "2026-08-28T00:02:00.000Z",
        receivedAt: "2026-08-28T00:02:01.000Z",
        traceId: "t2",
        orderingKey: "shop_1:checkout_1",
        eventType: "checkout.updated",
        payload: {
          checkoutToken: "checkout_1",
        },
      }),
    );

    const orderMapped = mapOrderCompletedContractInput(
      parseRuntimeShopifyEvent({
        schemaVersion: 2,
        receiptId: "r3",
        deliveryId: "d3",
        eventId: "e3",
        source: "shopify",
        providerTopic: "ORDERS_CREATE",
        tenant: { shopId: "shop_1", shopDomain: "shop.myshopify.com" },
        occurredAt: "2026-08-28T00:03:00.000Z",
        receivedAt: "2026-08-28T00:03:01.000Z",
        traceId: "t3",
        orderingKey: "shop_1:order_1",
        eventType: "order.completed",
        payload: {
          orderId: "gid://shopify/Order/1",
          checkoutToken: "checkout_1",
          cartToken: "cart_1",
          completedAt: "2026-08-28T00:03:00Z",
        },
      }),
    );

    expect(updatedMapped).toEqual({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_1",
    });

    expect(orderMapped).toEqual({
      shopDomain: "shop.myshopify.com",
      orderId: "gid://shopify/Order/1",
      checkoutToken: "checkout_1",
      cartToken: "cart_1",
      completedAt: "2026-08-28T00:03:00Z",
    });
  });
});
