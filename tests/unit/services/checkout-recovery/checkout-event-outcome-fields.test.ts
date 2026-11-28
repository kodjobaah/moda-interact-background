import { describe, expect, it } from "vitest";
import { checkoutEventOutcomeFields } from "../../../../src/services/checkout-recovery/checkout-event-outcome-fields.js";

describe("Shopify checkout outcome diagnostics", () => {
  it("retains traceable shop and queue identities, but not checkout URLs or tokens", () => {
    const fields = checkoutEventOutcomeFields(
      "checkout-created",
      {
        shopId: "shop-123",
        checkoutToken: "private-checkout-token",
        jobId: "shop-123--shopify-aabbcc",
      },
      {
        kind: "scheduled",
        outcome: "enqueued",
        delayMinutes: 30,
        abandonedCheckoutUrl: "https://secret.example/recover",
        checkoutToken: "private-checkout-token",
      },
    );
    expect(fields).toMatchObject({
      eventType: "checkout-created",
      shopId: "shop-123",
      jobId: "shop-123--shopify-aabbcc",
      kind: "scheduled",
      outcome: "enqueued",
      delayMinutes: 30,
    });
    expect(fields).toHaveProperty("checkoutDigest");
    expect(JSON.stringify(fields)).not.toMatch(
      /private-checkout-token|secret.example/,
    );
  });
  it("retains an existing persisted recovery ID and bounded reason", () => {
    expect(
      checkoutEventOutcomeFields(
        "checkout-updated",
        { shopId: "shop-1" },
        {
          kind: "ignored",
          reason: "subscription-frozen",
          recoveryId: "recovery-1",
        },
      ),
    ).toMatchObject({
      shopId: "shop-1",
      kind: "ignored",
      reason: "subscription-frozen",
      recoveryId: "recovery-1",
    });
  });
  it("drops malformed identifiers and untrusted response strings", () => {
    expect(
      checkoutEventOutcomeFields(
        "cart-activity",
        { shopId: "bad space", jobId: "https://secret" },
        {
          kind: "failed at https://secret.example",
          reason: "token=private",
          delayMinutes: -1,
        },
      ),
    ).toEqual({ eventType: "cart-activity", kind: "unclassified" });
  });
});
