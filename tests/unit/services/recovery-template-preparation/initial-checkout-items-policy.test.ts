import { describe, expect, it } from "vitest";
import { decideInitialCheckoutItemsBinding } from
  "../../../../src/services/recovery-template-preparation/initial-checkout-items-policy.js";

describe("initial checkout items binding policy", () => {
  it("requires one contiguous, positioned checkout summary binding for INITIAL", () => {
    expect(decideInitialCheckoutItemsBinding({ stage: "INITIAL", parameterBindingsSnapshot: {
      body: [{ position: 1, variable: "shop.name" },
        { position: 2, variable: "checkout.itemsSummary" }],
    } })).toEqual({ ok: true, bodyPosition: 2 });
    expect(decideInitialCheckoutItemsBinding({ stage: "INITIAL", parameterBindingsSnapshot: {
      body: [{ position: 1, variable: "shop.name" }],
    } })).toEqual({ ok: false, reason: "DEFINITION_UNAVAILABLE" });
    expect(decideInitialCheckoutItemsBinding({ stage: "INITIAL", parameterBindingsSnapshot: {
      body: [{ position: 1, variable: "checkout.itemsSummary" },
        { position: 2, variable: "checkout.itemsSummary" }],
    } })).toEqual({ ok: false, reason: "DEFINITION_UNAVAILABLE" });
  });

  it("rejects malformed positions but leaves FOLLOW_UP unrestricted", () => {
    expect(decideInitialCheckoutItemsBinding({ stage: "INITIAL", parameterBindingsSnapshot: {
      body: [{ position: 2, variable: "checkout.itemsSummary" }],
    } })).toEqual({ ok: false, reason: "BINDINGS_INVALID" });
    expect(decideInitialCheckoutItemsBinding({ stage: "INITIAL", parameterBindingsSnapshot: null }))
      .toEqual({ ok: false, reason: "BINDINGS_INVALID" });
    expect(decideInitialCheckoutItemsBinding({ stage: "FOLLOW_UP", parameterBindingsSnapshot: null }))
      .toEqual({ ok: true, bodyPosition: null });
  });
});
