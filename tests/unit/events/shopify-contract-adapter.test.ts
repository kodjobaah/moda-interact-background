import { describe, expect, it } from "vitest";
import {
  mapCheckoutCreatedContractInput,
  mapCartActivityContractInput,
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
      activityAt: "2026-08-28T00:00:00.000Z",
    });
  });

  it("preserves international context for checkout created and updated mappings", () => {
    const internationalContext = {
      languageTag: "en-GB",
      languageSource: "shopify" as const,
      countryCode: "GB",
      currencyCode: "GBP",
      timeZone: "Europe/London",
    };
    const created = parseRuntimeShopifyEvent({
      schemaVersion: 2,
      receiptId: "r-context-created",
      deliveryId: "d-context-created",
      eventId: "e-context-created",
      source: "shopify",
      providerTopic: "CHECKOUTS_CREATE",
      tenant: { shopId: "shop_1", shopDomain: "shop.myshopify.com" },
      occurredAt: "2026-08-28T00:00:00.000Z",
      receivedAt: "2026-08-28T00:00:01.000Z",
      traceId: "t-context-created",
      orderingKey: "shop_1:checkout_context",
      eventType: "checkout.created",
      internationalContext,
      payload: {
        checkoutToken: "checkout_context",
        cartToken: "cart_context",
        abandonedCheckoutUrl: "https://shop.example/recover",
        checkoutCreatedAt: "2026-08-28T00:00:00Z",
      },
    });
    const updated = parseRuntimeShopifyEvent({
      ...created,
      receiptId: "r-context-updated",
      deliveryId: "d-context-updated",
      eventId: "e-context-updated",
      providerTopic: "CHECKOUTS_UPDATE",
      eventType: "checkout.updated",
      payload: { checkoutToken: "checkout_context" },
    });

    expect(mapCheckoutCreatedContractInput(created).internationalContext).toEqual(
      internationalContext,
    );
    expect(mapCheckoutUpdatedContractInput(updated).internationalContext).toEqual(
      internationalContext,
    );
  });

  it("rejects legacy v1 events (no compatibility path)", () => {
    expect(() =>
      parseRuntimeShopifyEvent({
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
          lineItems: [],
          checkoutCreatedAt: "2026-08-28T00:00:00Z",
          checkoutUpdatedAt: null,
          completedAt: null,
        },
      }),
    ).toThrow();
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
      activityAt: "2026-08-28T00:02:00.000Z",
    });

    expect(orderMapped).toEqual({
      shopDomain: "shop.myshopify.com",
      orderId: "gid://shopify/Order/1",
      checkoutToken: "checkout_1",
      cartToken: "cart_1",
      completedAt: "2026-08-28T00:03:00Z",
    });
  });

  it("maps cart.activity with tenant correlation and canonical activity time", () => {
    const mapped = mapCartActivityContractInput(
      parseRuntimeShopifyEvent({
        schemaVersion: 2,
        receiptId: "r4",
        deliveryId: "d4",
        eventId: "e4",
        source: "shopify",
        providerTopic: "CARTS_UPDATE",
        tenant: { shopId: "shop_1", shopDomain: "shop.myshopify.com" },
        occurredAt: null,
        receivedAt: "2026-08-28T00:04:01.000Z",
        traceId: "t4",
        orderingKey: "cart:6:shop_1:6:cart_1",
        eventType: "cart.activity",
        payload: {
          cartToken: "cart_1",
          isEmpty: null,
        },
      }),
    );

    expect(mapped).toEqual({
      shopId: "shop_1",
      shopDomain: "shop.myshopify.com",
      cartToken: "cart_1",
      isEmpty: null,
      activityAt: "2026-08-28T00:04:01.000Z",
    });
  });
});

