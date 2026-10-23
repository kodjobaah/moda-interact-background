import { beforeEach, describe, expect, it, vi } from "vitest";
import { SHOPIFY_WEBHOOK_QUEUE_CONTRACTS } from "@modainteract/moda-interact-shared/shopify";
import {
  dispatchCheckoutQueueJob, type CheckoutQueueHandlers,
} from "../../../src/events/checkout-worker-dispatch.js";

const checkoutCreated = vi.fn(async () => undefined);
const checkoutUpdated = vi.fn(async () => undefined);
const cartActivity = vi.fn(async () => undefined);
const consentSync = vi.fn(async () => undefined);
const handlers: CheckoutQueueHandlers = { checkoutCreated, checkoutUpdated, cartActivity, consentSync };

const consent = {
  schemaVersion: 1, shopId: "shop-a", shopifyCustomerId: "12345",
  deliveryId: "delivery-1", triggeredAt: "2026-10-23T10:00:00.000Z",
};
const checkout = {
  schemaVersion: 2,
  receiptId: "receipt-1", deliveryId: "delivery-2", eventId: "event-1", source: "shopify",
  providerTopic: "CHECKOUTS_CREATE",
  tenant: { shopId: "shop-a", shopDomain: "a.myshopify.com" },
  occurredAt: "2026-10-23T10:00:00.000Z", receivedAt: "2026-10-23T10:00:01.000Z",
  traceId: "trace-a", orderingKey: "shop-a:checkout-1", eventType: "checkout.created",
  payload: { checkoutToken: "checkout-1", cartToken: null,
    abandonedCheckoutUrl: "https://a.myshopify.com/recover", checkoutCreatedAt: "2026-10-23T09:00:00Z" },
};

beforeEach(() => vi.clearAllMocks());

describe("checkout-events queue routing", () => {
  it("routes only the distinct consent-sync job to native state refresh (zero recovery/candidate/notice/billing paths)", async () => {
    await dispatchCheckoutQueueJob({
      name: SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.WHATSAPP_CONSENT_SYNC.jobName,
      data: consent,
    }, handlers);
    expect(consentSync).toHaveBeenCalledExactlyOnceWith(consent);
    expect(checkoutCreated).not.toHaveBeenCalled();
    expect(checkoutUpdated).not.toHaveBeenCalled();
    expect(cartActivity).not.toHaveBeenCalled();
  });

  it("preserves checkout created v2 routing and mapping", async () => {
    await dispatchCheckoutQueueJob({
      name: SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.jobName,
      data: checkout,
    }, handlers);
    expect(checkoutCreated).toHaveBeenCalledExactlyOnceWith({
      shopDomain: "a.myshopify.com", checkoutToken: "checkout-1", cartToken: null,
      abandonedCheckoutUrl: "https://a.myshopify.com/recover",
      checkoutCreatedAt: "2026-10-23T09:00:00Z", activityAt: "2026-10-23T10:00:00.000Z",
    });
    expect(consentSync).not.toHaveBeenCalled();
  });

  it("keeps checkout-updated and cart-activity routing distinct", async () => {
    const updated = { ...checkout, providerTopic: "CHECKOUTS_UPDATE", eventType: "checkout.updated",
      payload: { checkoutToken: "checkout-1" } };
    const cart = { ...checkout, providerTopic: "CARTS_UPDATE", eventType: "cart.activity",
      payload: { cartToken: "cart-1", isEmpty: true } };
    await dispatchCheckoutQueueJob({
      name: SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_UPDATED_EVENTS.jobName,
      data: updated,
    }, handlers);
    expect(checkoutUpdated).toHaveBeenCalledOnce();
    await dispatchCheckoutQueueJob({
      name: SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CART_ACTIVITY_EVENTS.jobName,
      data: cart,
    }, handlers);
    expect(cartActivity).toHaveBeenCalledOnce();
    expect(consentSync).not.toHaveBeenCalled();
  });

  it("does not route a consent payload under a checkout job name", async () => {
    await expect(dispatchCheckoutQueueJob({
      name: SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.jobName,
      data: consent,
    }, handlers)).rejects.toThrow();
    expect(consentSync).not.toHaveBeenCalled();
    expect(checkoutCreated).not.toHaveBeenCalled();
  });

  it("fails unknown job types closed before touching any handler", async () => {
    await expect(dispatchCheckoutQueueJob({ name: "unknown", data: consent }, handlers))
      .rejects.toThrow("Unknown checkout-events queue job name");
    expect(consentSync).not.toHaveBeenCalled();
    expect(checkoutCreated).not.toHaveBeenCalled();
  });
});
