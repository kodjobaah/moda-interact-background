import { describe, expect, it } from "vitest";

import {
  createWooChargePriceSnapshot,
  parseChargePaymentEvidence,
} from "../../../../src/services/woocommerce-billing/charge-payment-evidence.js";

const paidCharge = {
  billing_intents: [{ id: 17, status: "completed" }],
  transactions: [{
    id: 42,
    billing_intent_id: 17,
    completed_at: "2026-10-10T08:00:00Z",
    amount: "14.8100",
    amount_refunded: "0.000",
    url: "https://provider.invalid/private-transaction",
  }],
};

describe("Woo one-time charge payment evidence", () => {
  it("accepts one completed payment above the frozen pre-tax quote and emits only the exact v1 fields", () => {
    const result = parseChargePaymentEvidence(paidCharge);
    expect(result.evidence).toBeDefined();
    if (!result.evidence) throw new Error("expected payment evidence");

    expect(createWooChargePriceSnapshot({
      merchantPricingUsageEventId: "usage-9",
      quotedAmountMinor: 1234,
      quotedCurrency: "USD",
    }, result.evidence)).toEqual({
      schemaVersion: 1,
      provider: "WOOCOMMERCE",
      kind: "ONE_TIME_CHARGE",
      merchantPricingUsageEventId: "usage-9",
      quotedAmountMinor: 1234,
      quotedCurrency: "USD",
      providerBillingIntentId: "17",
      providerTransactionId: "42",
      providerTransactionAmount: "14.81",
      providerAmountRefunded: "0",
    });
  });

  it("rejects missing, ambiguous, invalid, and partially refunded payment proof", () => {
    expect(parseChargePaymentEvidence({ billing_intents: [], transactions: [] }))
      .toEqual({ errorCode: "CHARGE_PAYMENT_EVIDENCE_INCOMPLETE" });
    expect(parseChargePaymentEvidence({
      billing_intents: [{ id: 17, status: "failed" }],
      transactions: [{ ...paidCharge.transactions[0] }],
    })).toEqual({ errorCode: "CHARGE_PAYMENT_EVIDENCE_INCOMPLETE" });
    expect(parseChargePaymentEvidence({
      billing_intents: [{ id: 17, status: "completed" }],
      transactions: [],
    })).toEqual({ errorCode: "CHARGE_PAYMENT_EVIDENCE_INCOMPLETE" });
    expect(parseChargePaymentEvidence({
      ...paidCharge,
      transactions: [...paidCharge.transactions, { ...paidCharge.transactions[0], id: 43 }],
    })).toEqual({ errorCode: "CHARGE_PAYMENT_EVIDENCE_AMBIGUOUS" });
    expect(parseChargePaymentEvidence({
      ...paidCharge,
      transactions: [{ ...paidCharge.transactions[0], amount: "NaN" }],
    })).toEqual({ errorCode: "CHARGE_PAYMENT_AMOUNT_INVALID" });
    expect(parseChargePaymentEvidence({
      ...paidCharge,
      transactions: [{ ...paidCharge.transactions[0], amount_refunded: "0.01" }],
    })).toEqual({ errorCode: "CHARGE_PAYMENT_EVIDENCE_INCOMPLETE" });
    expect(parseChargePaymentEvidence({
      ...paidCharge,
      transactions: [{ ...paidCharge.transactions[0], amount: "0" }],
    })).toEqual({ errorCode: "CHARGE_PAYMENT_AMOUNT_INVALID" });
    expect(parseChargePaymentEvidence({
      ...paidCharge,
      transactions: [{ ...paidCharge.transactions[0], amount: "-1" }],
    })).toEqual({ errorCode: "CHARGE_PAYMENT_AMOUNT_INVALID" });
    expect(parseChargePaymentEvidence({
      ...paidCharge,
      transactions: [{ ...paidCharge.transactions[0], amount_refunded: "-0.01" }],
    })).toEqual({ errorCode: "CHARGE_PAYMENT_AMOUNT_INVALID" });
  });
});