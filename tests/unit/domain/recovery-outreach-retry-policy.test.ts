import { describe, expect, it } from "vitest";
import { decideRecoveryOutreachRetry } from "../../../src/domain/recovery-outreach-retry-policy.js";

const config = {
  recoveryDeliveryTemporaryRetryDelayMinutes: 7,
  recoveryDeliveryRateLimitRetryDelayMinutes: 29,
  recoveryDeliveryMarketingRetryDelayMinutes: 2880,
  recoveryDeliveryMaxRetries: 4,
};

const failedAt = new Date("2026-11-25T11:32:42.000Z");

describe("recovery outreach retry decision", () => {
  it.each(["2", "131000", "131016", "131057", "133004"])("defers temporary provider failure %s", code => {
    expect(decideRecoveryOutreachRetry(code, failedAt, config)).toEqual({
      policy: "AFTER_COOLDOWN", notBeforeAt: new Date("2026-11-25T11:39:42.000Z"),
    });
  });
  it.each(["4", "80007", "130429", "131056"])("defers rate-limited failure %s", code => {
    expect(decideRecoveryOutreachRetry(code, failedAt, config)).toEqual({
      policy: "AFTER_COOLDOWN", notBeforeAt: new Date("2026-11-25T12:01:42.000Z"),
    });
  });
  it("requires policy clearance as well as a minimum cooldown for 131049", () => {
    expect(decideRecoveryOutreachRetry("131049", failedAt, config)).toEqual({
      policy: "PROVIDER_POLICY_HOLD", notBeforeAt: new Date("2026-11-27T11:32:42.000Z"),
    });
  });
  it.each(["100", "190", "368", "131031", "131042", "131048", "132001", "132015", "132016"])(
    "requires verified repair for configuration or policy failure %s", code => {
      expect(decideRecoveryOutreachRetry(code, failedAt, config)).toEqual({ policy: "REPAIR_REQUIRED", notBeforeAt: null });
    },
  );
  it.each(["131021", "131026", "131050"])("does not recycle an undeliverable or opted-out recipient %s", code => {
    expect(decideRecoveryOutreachRetry(code, failedAt, config)).toEqual({ policy: "DO_NOT_RETRY", notBeforeAt: null });
  });
  it.each([null, "999999", "", "131049 "])("holds unknown or code-less definitive failure %s for review", code => {
    expect(decideRecoveryOutreachRetry(code, failedAt, config)).toEqual({ policy: "REVIEW_REQUIRED", notBeforeAt: null });
  });
  it.each([null, { ...config, recoveryDeliveryMaxRetries: 0 },
    { ...config, recoveryDeliveryMaxRetries: -1 }, { ...config, recoveryDeliveryTemporaryRetryDelayMinutes: 0 },
    { ...config, recoveryDeliveryRateLimitRetryDelayMinutes: 1.5 }, { ...config, recoveryDeliveryMarketingRetryDelayMinutes: 1439 },
    { ...config, recoveryDeliveryMaxRetries: 2_147_483_648 },
  ])("holds recoverable failures when configuration is absent, invalid or disabled", settings => {
    expect(decideRecoveryOutreachRetry("131016", failedAt, settings)).toEqual({ policy: "REVIEW_REQUIRED", notBeforeAt: null });
    expect(decideRecoveryOutreachRetry("131049", failedAt, settings)).toEqual({ policy: "REVIEW_REQUIRED", notBeforeAt: null });
    expect(decideRecoveryOutreachRetry("131026", failedAt, settings)).toEqual({ policy: "DO_NOT_RETRY", notBeforeAt: null });
  });
  it("never authorizes a retry using an invalid timestamp", () => {
    expect(decideRecoveryOutreachRetry("131016", new Date(NaN), config)).toEqual({ policy: "REVIEW_REQUIRED", notBeforeAt: null });
  });
});
