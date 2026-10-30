import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  InvalidWooCheckoutCaptureJob,
  parseWooCheckoutCaptureJob,
} from "../../../src/events/woo-checkout-capture.js";

const event = {
  schemaVersion: "woo.activity.v1",
  eventId: "checkout-event-1",
  eventType: "CHECKOUT_UPDATED",
  checkoutKey: "cart-key-1",
  occurredAt: "2026-10-20T12:00:00.000Z",
  checkout: {
    currency: "GBP",
    total: "29.99",
    items: [{ quantity: 2, productId: "123", sku: "SHIRT", unitPrice: "14.99", total: "29.98" }],
    contact: { email: "customer@example.test", phone: "+447700900123", firstName: "Pat" },
  },
} as const;
const digest = (value: object) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const shopId = "woo-shop-1";
const jobId = (shop: string, id: string) => `woo-checkout-${createHash("sha256")
  .update(shop).update("\0").update(id).digest("hex")}`;
const fixture = <T extends { eventId: string }>(payload: T = event as T) => ({
  id: jobId(shopId, payload.eventId), name: "checkout-updated",
  data: { ...payload, shopId, contentDigest: digest(payload) },
});

const supportedRestoration = {
  schemaVersion: "woo.cart-restore.v1",
  kind: "supported",
  appliedCouponCodes: ["save10"],
  lines: [{ productId: "123", quantity: 2 }],
} as const;
const unsupportedRestoration = {
  schemaVersion: "woo.cart-restore.v1",
  kind: "unsupported",
  reason: "CUSTOM_CART_ITEM_DATA",
  appliedCouponCodes: [],
} as const;

function invalid(input: unknown, reason?: InvalidWooCheckoutCaptureJob["reason"]) {
  expect(() => parseWooCheckoutCaptureJob(input as ReturnType<typeof fixture>))
    .toThrow(InvalidWooCheckoutCaptureJob);
  if (reason) {
    try { parseWooCheckoutCaptureJob(input as ReturnType<typeof fixture>); }
    catch (error) { expect((error as InvalidWooCheckoutCaptureJob).reason).toBe(reason); }
  }
}

describe("ARCH-035 Woo checkout capture queue boundary", () => {
  it("accepts the canonical API-008 job, including bounded customer fields, without mutation", () => {
    const input = fixture();
    expect(parseWooCheckoutCaptureJob(input)).toEqual({ ...event, shopId });
    expect(input.data.checkout.contact.email).toBe("customer@example.test");
    expect(Object.keys(parseWooCheckoutCaptureJob(input))).not.toContain("contentDigest");
  });

  it("keeps an absent restoration unknown and carries only Shared-validated snapshots", () => {
    expect(parseWooCheckoutCaptureJob(fixture())).toEqual({ ...event, shopId });

    for (const restoration of [supportedRestoration, unsupportedRestoration]) {
      const payload = { ...event, checkout: { ...event.checkout, restoration } };
      expect(parseWooCheckoutCaptureJob(fixture(payload)).checkout.restoration).toEqual(restoration);
    }
  });

  it("fails closed on queue kind, authenticated shop identity, replay digest and unknown version", () => {
    invalid({ ...fixture(), name: "order-lifecycle" }, "invalid_job_name");
    invalid({ ...fixture(), id: jobId("other-shop", event.eventId) }, "job_identity_mismatch");
    invalid({ ...fixture(), data: { ...fixture().data, shopId: "other-shop" } }, "job_identity_mismatch");
    invalid({ ...fixture(), data: { ...fixture().data, contentDigest: "0".repeat(64) } }, "digest_mismatch");
    invalid({ ...fixture(), data: { ...fixture().data, schemaVersion: "woo.activity.v2" } }, "invalid_payload");
    invalid({ ...fixture(), data: { ...fixture().data, eventType: "ORDER_PLACED" } }, "invalid_payload");
    invalid({ ...fixture(), data: { ...fixture().data, credential: "secret" } }, "invalid_payload");
    invalid({ ...fixture(), data: { ...fixture().data, shopId: "bad:shop" } }, "invalid_payload");
  });

  it("checks every nested field and maximum collection sizes independently from Shopify", () => {
    const base = fixture();
    const altered = (checkout: unknown) => ({ ...base, data: { ...base.data, checkout } });
    invalid(altered({ ...event.checkout, currency: "gbp" }), "invalid_payload");
    invalid(altered({ ...event.checkout, total: "-10" }), "invalid_payload");
    invalid(altered({ ...event.checkout, items: Array.from({ length: 51 }, () => ({ quantity: 1 })) }), "invalid_payload");
    invalid(altered({ ...event.checkout, items: [{ quantity: 0 }] }), "invalid_payload");
    invalid(altered({ ...event.checkout, contact: { email: "wrong-email" } }), "invalid_payload");
    invalid(altered({ ...event.checkout, contact: { phone: "123" } }), "invalid_payload");
    invalid(altered({ ...event.checkout, contact: { firstName: "X\nY" } }), "invalid_payload");
    invalid(altered({ ...event.checkout, restoration: {
      ...supportedRestoration,
      lines: [],
    } }), "invalid_payload");
    invalid(altered({ ...event.checkout, restoration: {
      ...unsupportedRestoration,
      lines: [{ productId: "123", quantity: 1 }],
    } }), "invalid_payload");
    invalid(altered({ ...event.checkout, additional: "unrecognised" }), "invalid_payload");
    invalid({ ...base, data: { ...base.data, occurredAt: "2026-02-30T12:00:00.000Z" } }, "invalid_payload");
    invalid({ ...base, data: { ...base.data, order: { orderId: "1" } } }, "invalid_payload");
    invalid({ ...base, data: null }, "invalid_payload");
  });
});
