import { describe, expect, it } from "vitest";
import { classifyInitialOutreachFallback } from
  "../../../../src/services/recovery-template-integration/initial-outreach-fallback-selection.js";

describe("classifyInitialOutreachFallback", () => {
  it("routes optional enrichment failures to neutral preparation only before admission", () => {
    expect(classifyInitialOutreachFallback({ kind: "OPTIONAL_ENRICHMENT_FAILURE",
      trigger: "MCP_UNAVAILABLE", beforeProviderAdmission: true }))
      .toEqual({ action: "PREPARE_NO_OFFER_TEXT", trigger: "MCP_UNAVAILABLE" });
  });

  it.each([
    "STOP", "CONSENT", "TERMINAL_RECOVERY_OR_ORDER", "WRONG_SHOP_OR_RECIPIENT",
    "MODERATION", "BILLING_OR_CAPACITY", "TEMPLATE_NOT_APPROVED", "CHECKOUT_ITEMS_UNAVAILABLE",
  ] as const)("never downgrades mandatory block %s", (reason) => {
    expect(classifyInitialOutreachFallback({ kind: "MANDATORY_SEND_BLOCK", reason }))
      .toEqual({ action: "DO_NOT_SEND", reason });
  });

  it.each(["DB_OR_CONFIG_UNAVAILABLE", "CURRENT_RECOVERY_UNVERIFIABLE"] as const)(
    "retries the same attempt for required state failure %s", (reason) => {
      expect(classifyInitialOutreachFallback({ kind: "TRANSIENT_REQUIRED_STATE", reason }))
        .toEqual({ action: "RETRY_EXISTING_ATTEMPT", reason });
    },
  );

  it("reconciles an uncertain provider outcome without selecting a second send", () => {
    expect(classifyInitialOutreachFallback({ kind: "PROVIDER_OUTCOME_UNCERTAIN" }))
      .toEqual({ action: "RECONCILE_EXISTING_SEND" });
  });
});