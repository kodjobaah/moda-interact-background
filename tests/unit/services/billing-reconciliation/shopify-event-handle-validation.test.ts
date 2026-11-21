import { describe, expect, it } from "vitest";

import {
  hasConfiguredCreditPackMeter,
  hasValidRecoveryReportingHandle,
} from "../../../../src/services/billing-reconciliation/shopify-event-handle-validation.js";

describe("Shopify App Event handle validation", () => {
  it("allows a separate non-billable recovery reporting handle even when the plan has no meters", () => {
    expect(hasValidRecoveryReportingHandle("starter", [])).toBe(true);
    expect(hasValidRecoveryReportingHandle("start", ["bronze-top-up", "silver-top-up"])).toBe(true);
  });

  it.each([null, undefined, "", "   "])("rejects a missing recovery reporting handle: %s", (handle) => {
    expect(hasValidRecoveryReportingHandle(handle, ["bronze-top-up"])).toBe(false);
  });

  it("rejects a recovery reporting handle that is also a billable usage meter", () => {
    expect(hasValidRecoveryReportingHandle("starter", ["starter", "bronze-top-up"])).toBe(false);
  });

  it("rejects accidental inclusion of a recovery reporting handle among billable meters", () => {
    expect(hasValidRecoveryReportingHandle("recovery-audit", ["recovery-audit", "bronze-top-up"])).toBe(false);
    expect(hasValidRecoveryReportingHandle("recovery-audit", ["bronze-top-up"])).toBe(true);
  });

  it("requires a purchased-credit event handle to match a billable usage meter", () => {
    expect(hasConfiguredCreditPackMeter("bronze-top-up", ["bronze-top-up", "silver-top-up"])).toBe(true);
    expect(hasConfiguredCreditPackMeter("bronze-top-up", ["silver-top-up"])).toBe(false);
    expect(hasConfiguredCreditPackMeter(null, ["silver-top-up"])).toBe(false);
    expect(hasConfiguredCreditPackMeter("", [""])).toBe(false);
  });
});
