import { describe, expect, it } from "vitest";

import { operationForReceipt } from "../../../../src/services/woocommerce-billing/subscription-receipt-operation-correlation.js";
import type { WooRecurringOperation } from "../../../../src/services/woocommerce-billing/subscription-operation-resolution.js";
import type { WooSubscriptionEvidence } from "../../../../src/services/woocommerce-billing/subscription-receipt-evidence.js";

const operations: WooRecurringOperation[] = [
  {
    id: "create-a",
    kind: "SUBSCRIPTION_CREATE",
    state: "CONFIRMED",
    createdAt: new Date("2026-10-01T00:00:00Z"),
    merchantPricingPlanId: "catalogue-a",
    quotedAmountMinor: 1999,
    merchantPricingPlan: { displayName: "Growth", shopifyPlanHandle: "growth" },
    providerReference: "contract-a",
  },
  {
    id: "switch-a",
    kind: "PLAN_SWITCH",
    state: "AWAITING_CONFIRMATION",
    createdAt: new Date("2026-10-02T00:00:00Z"),
    merchantPricingPlanId: "catalogue-b",
    quotedAmountMinor: 2999,
    merchantPricingPlan: { displayName: "Scale", shopifyPlanHandle: "scale" },
    providerReference: "contract-a",
  },
  {
    id: "cancel-a",
    kind: "CANCEL",
    state: "AWAITING_CONFIRMATION",
    createdAt: new Date("2026-10-03T00:00:00Z"),
    merchantPricingPlanId: null,
    quotedAmountMinor: null,
    merchantPricingPlan: null,
    providerReference: "contract-a",
  },
];

function receipt(topic: WooSubscriptionEvidence["topic"], name = "Growth", price = 1999): WooSubscriptionEvidence {
  return {
    topic,
    contractId: "contract-a",
    status: "active",
    financial: null,
    activationAt: null,
    termEndAt: null,
    providerModifiedAt: new Date("2026-10-04T00:00:00Z"),
    planObservedAt: new Date("2026-10-04T00:00:00Z"),
    planName: name,
    planPriceMinor: price,
  };
}

describe("operationForReceipt", () => {
  it("attributes first and duplicate activation receipts to the unique compatible create", () => {
    const activated = receipt("saas_billing_contract.activated");

    expect(operationForReceipt(activated, operations)).toBe("create-a");
    expect(operationForReceipt(activated, operations)).toBe("create-a");
  });

  it("links updated only to its uniquely matching switch and canceled only to cancel", () => {
    expect(operationForReceipt(receipt("saas_billing_contract.updated", "Scale", 2999), operations)).toBe("switch-a");
    expect(operationForReceipt(receipt("saas_billing_contract.canceled"), operations)).toBe("cancel-a");
  });

  it.each([
    "saas_billing_contract.renewed",
    "saas_billing_contract.paused",
    "saas_billing_contract.refunded",
  ] as const)("does not borrow a plan or cancellation link for %s", (topic) => {
    expect(operationForReceipt(receipt(topic), operations)).toBeNull();
  });

  it("fails closed when multiple create operations match one activation snapshot", () => {
    expect(operationForReceipt(receipt("saas_billing_contract.activated"), [
      ...operations,
      { ...operations[0]!, id: "create-b" },
    ])).toBeNull();
  });
});