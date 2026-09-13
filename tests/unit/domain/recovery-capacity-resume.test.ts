import { describe, expect, it } from "vitest";

import {
  createRecoveryCapacityResumeContinuation,
  createRecoveryCapacityResumeJobId,
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
});
