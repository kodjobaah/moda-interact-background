import { describe, expect, it } from "vitest";

import {
  capacityHarness,
  normalInput,
  paidPolicy,
} from "./recovery-capacity-admission.test-support.js";

describe("RecoveryCapacityAdmissionService Paid routing", () => {
  it("reserves selected promotional capacity before Paid included capacity", async () => {
    const harness = capacityHarness({
      promotionalReserve: {
        kind: "reserved" as const,
        reservation: {},
        sourceKey: "recovery:shop-1:recovery-1",
      },
    });

    await expect(harness.service.admit(normalInput(paidPolicy()))).resolves.toMatchObject({
      kind: "admitted",
      admission: { kind: "promotional" },
    });
    expect(harness.promotional.reserve).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "recovery:shop-1:recovery-1",
      planId: "paid-plan",
    });
    expect(harness.paid.reserve).not.toHaveBeenCalled();
  });

  it("falls from unavailable promotional capacity to Paid included capacity", async () => {
    const harness = capacityHarness();

    await expect(harness.service.admit(normalInput(paidPolicy()))).resolves.toMatchObject({
      kind: "admitted",
      admission: { kind: "paid" },
    });
    expect(harness.promotional.reserve).toHaveBeenCalledOnce();
    expect(harness.paid.reserve).toHaveBeenCalledWith({
      shopId: "shop-1",
      recoveryId: "recovery-1",
    });
    expect(harness.purchased.reserve).not.toHaveBeenCalled();
  });

  it("uses the outreach source key for Paid included reservation identity", async () => {
    const harness = capacityHarness();

    await expect(
      harness.service.admit(
        normalInput(paidPolicy(), {
          outreachAttemptId: "attempt-1",
          sourceKey: "recovery:shop-1:recovery-outreach:attempt-1",
        }),
      ),
    ).resolves.toMatchObject({ kind: "admitted", admission: { kind: "paid" } });
    expect(harness.paid.reserve).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "recovery:shop-1:recovery-outreach:attempt-1",
    });
  });

  it("does not infer Paid included exhaustion from recovery-pack policy", async () => {
    const harness = capacityHarness();
    const policy = paidPolicy("ACTIVE", {
      recoveryCreditPack: {
        enabled: true,
        creditsPerPack: 5,
        shopifyEventHandle: "recovery-pack",
        includedRecoveryConversationAllowance: 200,
        normalRecoveryUsageQuantity: 200,
      },
    });

    await expect(harness.service.admit(normalInput(policy))).resolves.toMatchObject({
      kind: "admitted",
      admission: { kind: "paid" },
    });
    expect(harness.purchased.reserve).not.toHaveBeenCalled();
    expect(harness.free.reserve).not.toHaveBeenCalled();
  });

  it("uses purchased capacity after Paid included capacity is exhausted", async () => {
    const harness = capacityHarness({
      paidReserve: { kind: "allowance-exhausted" as const, remaining: 0, policy: paidPolicy() },
      purchasedReserve: {
        kind: "reserved" as const,
        reservation: {},
        counter: "PURCHASED_RECOVERY_CREDITS" as const,
      },
    });

    await expect(harness.service.admit(normalInput(paidPolicy()))).resolves.toMatchObject({
      kind: "admitted",
      admission: { kind: "purchased" },
    });
    expect(harness.purchased.reserve).toHaveBeenCalledOnce();
    expect(harness.free.reserve).not.toHaveBeenCalled();
  });

  it("uses lifetime Free after Paid included and purchased capacity are exhausted", async () => {
    const harness = capacityHarness({
      paidReserve: { kind: "allowance-exhausted" as const, remaining: 0, policy: paidPolicy() },
      freeReserve: {
        kind: "reserved" as const,
        reservation: {},
        counter: "LIFETIME_FREE_RECOVERY_CREDITS" as const,
      },
    });

    await expect(harness.service.admit(normalInput(paidPolicy()))).resolves.toMatchObject({
      kind: "admitted",
      admission: { kind: "lifetime-free" },
    });
    expect(harness.purchased.reserve).toHaveBeenCalledOnce();
    expect(harness.free.reserve).toHaveBeenCalledOnce();
  });

  it("returns capacity-exhausted when every ACTIVE Paid source is exhausted", async () => {
    const harness = capacityHarness({
      paidReserve: { kind: "allowance-exhausted" as const, remaining: 0, policy: paidPolicy() },
    });

    await expect(harness.service.admit(normalInput(paidPolicy()))).resolves.toEqual({
      kind: "blocked",
      reason: "capacity-exhausted",
    });
    expect(harness.paid.reserve).toHaveBeenCalledOnce();
    expect(harness.purchased.reserve).toHaveBeenCalledOnce();
    expect(harness.free.reserve).toHaveBeenCalledOnce();
  });

  it.each(["already-ambiguous", "already-released"] as const)(
    "does not switch funding buckets for an included %s replay",
    async (kind) => {
      const harness = capacityHarness({
        paidReserve: {
          kind,
          reservation: {},
          counter: "INCLUDED_RECOVERY_CREDITS" as const,
        },
      });

      await expect(harness.service.admit(normalInput(paidPolicy()))).resolves.toEqual({
        kind: "blocked",
        reason: "reservation-in-flight",
      });
      expect(harness.purchased.reserve).not.toHaveBeenCalled();
      expect(harness.free.reserve).not.toHaveBeenCalled();
    },
  );

  it("does not reserve Paid included capacity during DRAINING", async () => {
    const harness = capacityHarness({
      purchasedReserve: {
        kind: "reserved" as const,
        reservation: {},
        counter: "PURCHASED_RECOVERY_CREDITS" as const,
      },
    });

    await expect(
      harness.service.admit(normalInput(paidPolicy("DRAINING"))),
    ).resolves.toMatchObject({ kind: "admitted", admission: { kind: "purchased" } });
    expect(harness.paid.reserve).not.toHaveBeenCalled();
  });

  it("uses the closing reason only after DRAINING durable fallbacks are exhausted", async () => {
    const harness = capacityHarness();

    await expect(
      harness.service.admit(normalInput(paidPolicy("DRAINING"))),
    ).resolves.toEqual({ kind: "blocked", reason: "billing-period-closing" });
    expect(harness.paid.reserve).not.toHaveBeenCalled();
    expect(harness.purchased.reserve).toHaveBeenCalledOnce();
    expect(harness.free.reserve).toHaveBeenCalledOnce();
  });
});
