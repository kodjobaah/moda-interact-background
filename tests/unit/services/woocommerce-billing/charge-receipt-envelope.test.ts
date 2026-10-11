import { describe, expect, it } from "vitest";

import { readWooChargeEnvelope } from "../../../../src/services/woocommerce-billing/charge-receipt-envelope.js";

describe("Woo one-time charge receipt envelope", () => {
  it("requires a top-level charge with the receipt contract id and topic-compatible status", () => {
    const valid = { charge: { id: "charge-1", status: "active" } };
    expect(readWooChargeEnvelope(valid, "charge-1", "saas_billing_contract.activated"))
      .toEqual({ charge: valid.charge });
    expect(readWooChargeEnvelope({ subscription: valid.charge }, "charge-1", "saas_billing_contract.activated"))
      .toEqual({ errorCode: "CHARGE_PROVIDER_STATUS_CONFLICT" });
    expect(readWooChargeEnvelope(valid, "charge-2", "saas_billing_contract.activated"))
      .toEqual({ errorCode: "CHARGE_PROVIDER_STATUS_CONFLICT" });
    expect(readWooChargeEnvelope(valid, "charge-1", "saas_billing_contract.canceled"))
      .toEqual({ errorCode: "CHARGE_PROVIDER_STATUS_CONFLICT" });
  });
});