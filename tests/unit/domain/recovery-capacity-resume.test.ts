import { describe, expect, it } from "vitest";

import {
  createRecoveryCapacityResumeContinuation,
  createRecoveryCapacityResumeJobId,
  createRecoveryCapacityResumeMaturitySuccessor,
} from "../../../src/domain/recovery-capacity-resume.js";

describe("recovery capacity resume job identity", () => {
  it("returns the same deterministic job id for the same shop and trigger", () => {
    const input = {
      shopId: "shop-1",
      trigger: "purchase-activation-period-1",
    };

    expect(createRecoveryCapacityResumeJobId(input)).toBe(
      "recovery-capacity-resume--shop-1--purchase-activation-period-1",
    );
    expect(createRecoveryCapacityResumeJobId(input)).toBe(
      createRecoveryCapacityResumeJobId({ ...input }),
    );
  });

  it("uses the continuation recovery id only to create a distinct trigger/job identity", () => {
    const input = { shopId: "shop-1", trigger: "repair" };

    const first = createRecoveryCapacityResumeContinuation(
      input,
      "recovery-25",
    );
    const second = createRecoveryCapacityResumeContinuation(
      input,
      "recovery-50",
    );

    expect(first).toEqual({
      shopId: "shop-1",
      trigger: "continuation-recovery-25",
    });
    expect(second).toEqual({
      shopId: "shop-1",
      trigger: "continuation-recovery-50",
    });
    expect(createRecoveryCapacityResumeJobId(first)).not.toBe(
      createRecoveryCapacityResumeJobId(second),
    );
  });

  it("creates a distinct deterministic maturity successor for each active trigger", () => {
    const input = {
      shopId: "shop-1",
      recoveryId: "recovery-1",
      lastExternalActivityAt: new Date("2026-10-11T20:00:00.000Z"),
      currentTrigger: "recipient-suppression-recovery-1-maturity-1",
    };

    const first = createRecoveryCapacityResumeMaturitySuccessor(input);
    const retry = createRecoveryCapacityResumeMaturitySuccessor(input);
    const successor = createRecoveryCapacityResumeMaturitySuccessor({
      ...input,
      currentTrigger: first.trigger,
    });

    expect(retry).toEqual(first);
    expect(first.trigger).not.toBe(input.currentTrigger);
    expect(successor.trigger).not.toBe(first.trigger);
    expect(createRecoveryCapacityResumeJobId(successor)).not.toBe(
      createRecoveryCapacityResumeJobId(first),
    );
  });
});
