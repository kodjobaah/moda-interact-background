import { describe, expect, it } from "vitest";
import { SubscriptionProjectionStatus } from "@prisma/client";
import {
  isBlockedUnfreezeAccountingState,
  canRevalidateRepairedUnfreezePeriod,
  isUnresolvedUnfreezeAccountingError,
  unfreezeAccountingErrorCode,
} from "../../../../src/services/billing-reconciliation/unfreeze-integrity-guard.js";

describe("unfreeze accounting error provenance", () => {
  it.each([
    "BILLING_PERIOD_PLAN_CONFLICT",
    "LIFETIME_FREE_COUNTER_HISTORY_CONFLICT",
    "PRE_CLOSE_USAGE_FLUSH_FAILED",
  ])("stamps an explicit unfreeze code for %s", (sourceCode) => {
    const code = unfreezeAccountingErrorCode(sourceCode);
    expect(code).toBe(`UNFREEZE_${sourceCode}`);
    expect(unfreezeAccountingErrorCode(code)).toBe(code);
    expect(isUnresolvedUnfreezeAccountingError(sourceCode)).toBe(true);
    expect(isBlockedUnfreezeAccountingState({
      status: SubscriptionProjectionStatus.SYNC_ERROR, lastSyncErrorCode: code,
    })).toBe(true);
    expect(isBlockedUnfreezeAccountingState({
      status: SubscriptionProjectionStatus.FROZEN, lastSyncErrorCode: code,
    })).toBe(true);
  });

  it("revalidates only a blocked same-cycle conflict, never a new FROZEN state", () => {
    const blocked = { status: SubscriptionProjectionStatus.SYNC_ERROR, lastSyncErrorCode: "UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT" };
    expect(canRevalidateRepairedUnfreezePeriod(blocked, "UPDATED")).toBe(true);
    expect(canRevalidateRepairedUnfreezePeriod(blocked, "CANCELLATION_SCHEDULED")).toBe(true);
    expect(canRevalidateRepairedUnfreezePeriod(blocked, "FROZEN")).toBe(false);
    expect(canRevalidateRepairedUnfreezePeriod({ ...blocked, status: SubscriptionProjectionStatus.FROZEN }, "UPDATED")).toBe(false);
    expect(canRevalidateRepairedUnfreezePeriod({ ...blocked, lastSyncErrorCode: "UNFREEZE_PRE_CLOSE_USAGE_FLUSH_FAILED" }, "UPDATED")).toBe(false);
  });

  it("does not infer a failed unfreeze from a later normal billing conflict and a historical UNFROZEN event", () => {
    expect(isBlockedUnfreezeAccountingState({
      status: SubscriptionProjectionStatus.SYNC_ERROR,
      lastSyncErrorCode: "BILLING_PERIOD_PLAN_CONFLICT",
    })).toBe(false);
    expect(isBlockedUnfreezeAccountingState({
      status: SubscriptionProjectionStatus.ACTIVE,
      lastSyncErrorCode: "UNFREEZE_BILLING_PERIOD_PLAN_CONFLICT",
    })).toBe(false);
  });
});
