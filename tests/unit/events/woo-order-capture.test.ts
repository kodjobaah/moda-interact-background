import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  InvalidWooOrderCaptureJob,
  parseWooOrderCaptureJob,
} from "../../../src/events/woo-order-capture.js";

const digest = (value: object) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const jobId = (shopId: string, eventId: string) => `woo-order-${createHash("sha256")
  .update(shopId).update("\0").update(eventId).digest("hex")}`;
const shopId = "woo-shop-1";
const event = (eventType: "ORDER_PLACED" | "ORDER_PAID" | "ORDER_CANCELLED" = "ORDER_PLACED") => ({
  schemaVersion: "woo.activity.v1", eventId: "order-event-1", eventType,
  checkoutKey: "cart-key-1", occurredAt: "2026-10-20T12:00:00.000Z",
  order: { orderId: "order-123", checkoutKey: "cart-key-1", status: "processing" },
});
const fixture = (kind: "ORDER_PLACED" | "ORDER_PAID" | "ORDER_CANCELLED" = "ORDER_PLACED") => {
  const payload = event(kind);
  return {
    id: jobId(shopId, payload.eventId), name: "order-lifecycle",
    data: { ...payload, shopId, contentDigest: digest(payload) },
  };
};

function invalid(input: unknown, reason: InvalidWooOrderCaptureJob["reason"]) {
  try {
    parseWooOrderCaptureJob(input as ReturnType<typeof fixture>);
    throw new Error("expected invalid Woo order job");
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidWooOrderCaptureJob);
    expect((error as InvalidWooOrderCaptureJob).reason).toBe(reason);
  }
}

describe("ARCH-035 Woo order capture contract", () => {
  it.each(["ORDER_PLACED", "ORDER_PAID", "ORDER_CANCELLED"] as const)(
    "accepts the exact API-019 %s job without deriving payment or recovery state", (kind) => {
      const input = fixture(kind);
      expect(parseWooOrderCaptureJob(input)).toEqual({ ...event(kind), shopId });
      expect(Object.keys(parseWooOrderCaptureJob(input))).not.toContain("contentDigest");
    },
  );

  it("rejects wrong queue kind, wrong shop, different job identity, digest tampering and version drift", () => {
    invalid({ ...fixture(), name: "checkout-updated" }, "invalid_job_name");
    invalid({ ...fixture(), id: jobId("another-shop", "order-event-1") }, "job_identity_mismatch");
    invalid({ ...fixture(), data: { ...fixture().data, shopId: "another-shop" } }, "job_identity_mismatch");
    invalid({ ...fixture(), data: { ...fixture().data, contentDigest: "f".repeat(64) } }, "digest_mismatch");
    invalid({ ...fixture(), data: { ...fixture().data, schemaVersion: "woo.activity.v2" } }, "invalid_payload");
    invalid({ ...fixture(), data: { ...fixture().data, shopId: "bad:shop" } }, "invalid_payload");
    invalid({ ...fixture(), data: { ...fixture().data, secret: "token" } }, "invalid_payload");
  });

  it("requires exact order/checkout correlation and bounded observed Woo order status", () => {
    const original = fixture();
    const changedOrder = (order: unknown) => ({ ...original, data: { ...original.data, order } });
    invalid(changedOrder({ ...original.data.order, checkoutKey: "cart-two" }), "invalid_payload");
    invalid(changedOrder({ ...original.data.order, orderId: "" }), "invalid_payload");
    invalid(changedOrder({ ...original.data.order, status: "PAID" }), "invalid_payload");
    invalid(changedOrder({ ...original.data.order, status: "processing\nprivate" }), "invalid_payload");
    invalid(changedOrder({ ...original.data.order, extra: "bad" }), "invalid_payload");
    invalid({ ...original, data: { ...original.data, checkoutKey: "cart-two" } }, "invalid_payload");
    invalid({ ...original, data: { ...original.data, checkout: { currency: "GBP" } } }, "invalid_payload");
    invalid({ ...original, data: { ...original.data, eventType: "CHECKOUT_UPDATED" } }, "invalid_payload");
    invalid({ ...original, data: { ...original.data, occurredAt: "2026-02-30T12:00:00.000Z" } }, "invalid_payload");
    invalid({ ...original, data: null }, "invalid_payload");
  });

  it("accepts out-of-order distinct lifecycle events without fabricating an earlier checkout", () => {
    const paid = { ...fixture("ORDER_PAID"), data: { ...fixture("ORDER_PAID").data } };
    const placed = fixture("ORDER_PLACED");
    const paidEvent = { ...event("ORDER_PAID"), eventId: "paid-first" };
    paid.id = jobId(shopId, paidEvent.eventId);
    paid.data = { ...paidEvent, shopId, contentDigest: digest(paidEvent) };
    expect(parseWooOrderCaptureJob(paid).eventType).toBe("ORDER_PAID");
    expect(parseWooOrderCaptureJob(placed).eventType).toBe("ORDER_PLACED");
    expect(jobId("woo-shop-2", paidEvent.eventId)).not.toBe(paid.id);
  });
});
