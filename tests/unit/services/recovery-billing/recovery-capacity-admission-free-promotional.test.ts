import { describe, expect, it } from "vitest";

import {
  capacityHarness,
  freePolicy,
  normalInput,
  paidPolicy,
} from "./recovery-capacity-admission.test-support.js";

describe("RecoveryCapacityAdmissionService Free and promotional routing", () => {
  it("uses Free-plan promotional capacity before purchased or lifetime capacity", async () => {
    const harness = capacityHarness({
      promotionalReserve: {
        kind: "reserved" as const,
        reservation: {},
        sourceKey: "recovery:shop-1:recovery-1",
      },
    });

    await expect(harness.service.admit(normalInput(freePolicy()))).resolves.toMatchObject({
      kind: "admitted",
      admission: { kind: "promotional" },
    });
    expect(harness.purchased.reserve).not.toHaveBeenCalled();
    expect(harness.free.reserve).not.toHaveBeenCalled();
  });

  it("falls from unavailable promotion to purchased before lifetime Free", async () => {
    const harness = capacityHarness({
      purchasedReserve: {
        kind: "reserved" as const,
        reservation: {},
        counter: "PURCHASED_RECOVERY_CREDITS" as const,
      },
      freeReserve: {
        kind: "reserved" as const,
        reservation: {},
        counter: "LIFETIME_FREE_RECOVERY_CREDITS" as const,
      },
    });

    await expect(harness.service.admit(normalInput(freePolicy()))).resolves.toMatchObject({
      kind: "admitted",
      admission: { kind: "purchased" },
    });
    expect(harness.purchased.reserve).toHaveBeenCalledOnce();
    expect(harness.free.reserve).not.toHaveBeenCalled();
  });

  it("falls from exhausted purchased capacity to lifetime Free", async () => {
    const harness = capacityHarness({
      freeReserve: {
        kind: "reserved" as const,
        reservation: {},
        counter: "LIFETIME_FREE_RECOVERY_CREDITS" as const,
      },
    });

    await expect(harness.service.admit(normalInput(freePolicy()))).resolves.toMatchObject({
      kind: "admitted",
      admission: { kind: "lifetime-free" },
    });
    expect(harness.purchased.reserve).toHaveBeenCalledOnce();
    expect(harness.free.reserve).toHaveBeenCalledOnce();
  });

  it("observes newly restored purchased capacity on a later admission", async () => {
    const harness = capacityHarness();
    harness.purchased.reserve
      .mockResolvedValueOnce({ kind: "credits-exhausted" as const, available: 0 })
      .mockResolvedValueOnce({
        kind: "reserved" as const,
        reservation: {},
        counter: "PURCHASED_RECOVERY_CREDITS" as const,
      });

    await expect(harness.service.admit(normalInput(freePolicy()))).resolves.toEqual({
      kind: "blocked",
      reason: "capacity-exhausted",
    });
    await expect(
      harness.service.admit(
        normalInput(freePolicy(), {
          recoveryId: "recovery-2",
          sourceKey: "recovery:shop-1:recovery-2",
        }),
      ),
    ).resolves.toMatchObject({ kind: "admitted", admission: { kind: "purchased" } });
  });

  it("keeps spending existing purchased credits even when pack purchasing is disabled", async () => {
    const harness = capacityHarness({
      purchasedReserve: {
        kind: "reserved" as const,
        reservation: {},
        counter: "PURCHASED_RECOVERY_CREDITS" as const,
      },
    });
    const policy = freePolicy({
      recoveryCreditPack: {
        enabled: false,
        creditsPerPack: 5,
        shopifyEventHandle: "recovery-pack",
      },
    });

    await expect(harness.service.admit(normalInput(policy))).resolves.toMatchObject({
      kind: "admitted",
      admission: { kind: "purchased" },
    });
  });

  it("returns capacity-exhausted only after Free purchased and lifetime capacity are exhausted", async () => {
    const harness = capacityHarness();

    await expect(harness.service.admit(normalInput(freePolicy()))).resolves.toEqual({
      kind: "blocked",
      reason: "capacity-exhausted",
    });
    expect(harness.purchased.reserve).toHaveBeenCalledOnce();
    expect(harness.free.reserve).toHaveBeenCalledOnce();
  });

  it.each(["already-ambiguous", "already-released"] as const)(
    "keeps a promotional %s replay from switching capacity source",
    async (kind) => {
      const harness = capacityHarness({
        promotionalReserve: {
          kind,
          reservation: {},
          sourceKey: "recovery:shop-1:recovery-1",
        },
      });

      await expect(harness.service.admit(normalInput(paidPolicy()))).resolves.toEqual({
        kind: "blocked",
        reason: "reservation-in-flight",
      });
      expect(harness.paid.reserve).not.toHaveBeenCalled();
      expect(harness.purchased.reserve).not.toHaveBeenCalled();
      expect(harness.free.reserve).not.toHaveBeenCalled();
    },
  );

  it("falls through promotion, Paid included, purchased, and lifetime Free in order", async () => {
    const harness = capacityHarness({
      paidReserve: {
        kind: "allowance-exhausted" as const,
        remaining: 0,
        policy: paidPolicy(),
      },
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
    expect(harness.promotional.reserve).toHaveBeenCalledOnce();
    expect(harness.paid.reserve).toHaveBeenCalledOnce();
    expect(harness.purchased.reserve).toHaveBeenCalledOnce();
    expect(harness.free.reserve).toHaveBeenCalledOnce();
  });
});
