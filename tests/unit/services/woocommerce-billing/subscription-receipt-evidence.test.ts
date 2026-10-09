import { describe, expect, it } from "vitest";

import { parseWooSubscriptionEvidence } from "../../../../src/services/woocommerce-billing/subscription-receipt-evidence.js";

const wrapper = (overrides: Record<string, unknown> = {}) => ({
  subscription: {
    id: "contract-a",
    status: "active",
    name: "Growth",
    price: "19.99",
    date_modified: "2026-10-08 10:00:00",
    next_payment_date: "2026-11-08 10:00:00",
    end_date: null,
    billing_intents: [{ id: 4, status: "completed", updated_at: "2026-10-08 09:59:00" }],
    transactions: [{ id: 17, billing_intent_id: 4, completed_at: "2026-10-08 10:00:00" }],
    ...overrides,
  },
});

describe("parseWooSubscriptionEvidence", () => {
  it("uses completed transaction time and preserves provider snapshot values", () => {
    const evidence = parseWooSubscriptionEvidence(
      "saas_billing_contract.activated",
      "contract-a",
      wrapper(),
    );

    expect(evidence.activationAt?.toISOString()).toBe("2026-10-08T10:00:00.000Z");
    expect(evidence.financial?.providerAt).toEqual(evidence.activationAt);
    expect(evidence.financial?.coverageEndAt?.toISOString()).toBe("2026-11-08T10:00:00.000Z");
    expect(evidence.planName).toBe("Growth");
    expect(evidence.planPriceMinor).toBe(1999);
  });

  it("keeps provider snapshot time distinct from an older completed payment", () => {
    const evidence = parseWooSubscriptionEvidence(
      "saas_billing_contract.updated",
      "contract-a",
      wrapper({
        date_modified: "2026-10-08 10:05:00",
        transactions: [{ id: 17, billing_intent_id: 4, completed_at: "2026-10-01 10:00:00" }],
      }),
    );

    expect(evidence.planObservedAt?.toISOString()).toBe("2026-10-08T10:05:00.000Z");
    expect(evidence.financial?.providerAt.toISOString()).toBe("2026-10-08T10:05:00.000Z");
  });

  it("does not accept renewed without a completed billing-intent transaction", () => {
    expect(() => parseWooSubscriptionEvidence(
      "saas_billing_contract.renewed",
      "contract-a",
      wrapper({ transactions: [] }),
    )).toThrow("RENEWAL_PAYMENT_EVIDENCE_MISSING");
  });

  it("does not count a transaction whose billing intent is not completed", () => {
    expect(() => parseWooSubscriptionEvidence(
      "saas_billing_contract.activated",
      "contract-a",
      wrapper({ billing_intents: [{ id: 4, status: "pending" }] }),
    )).toThrow("ACTIVATION_PAYMENT_EVIDENCE_MISSING");
  });

  it("requires a signed prepaid end date for cancellation topics", () => {
    expect(() => parseWooSubscriptionEvidence(
      "saas_billing_contract.canceled",
      "contract-a",
      wrapper({ status: "canceled", end_date: null }),
    )).toThrow("TERM_END_EVIDENCE_MISSING");
  });

  it("rejects a wrapper whose contract identity differs from the durable receipt", () => {
    expect(() => parseWooSubscriptionEvidence(
      "saas_billing_contract.renewed",
      "contract-b",
      wrapper(),
    )).toThrow("INVALID_SUBSCRIPTION_ENVELOPE");
  });
});