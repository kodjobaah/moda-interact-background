import { describe, expect, it, vi } from "vitest";

import { RecoveryDurableCreditAdmissionService } from "../../../../src/services/recovery-billing/recovery-durable-credit-admission.service.js";
import {
  freePolicy,
  postContractPolicy,
} from "./recovery-capacity-admission.test-support.js";

function harness(input: {
  freeReserve?: unknown;
  freeReservePostContract?: unknown;
  purchasedReserve?: unknown;
} = {}) {
  const free = {
    reserve: vi.fn(async () =>
      input.freeReserve ?? { kind: "allowance-exhausted" as const, remaining: 0 },
    ),
    reservePostContract: vi.fn(async () =>
      input.freeReservePostContract ?? {
        kind: "allowance-exhausted" as const,
        remaining: 0,
      },
    ),
  };
  const purchased = {
    reserve: vi.fn(async () =>
      input.purchasedReserve ?? { kind: "credits-exhausted" as const, available: 0 },
    ),
  };
  return {
    service: new RecoveryDurableCreditAdmissionService(
      free as never,
      purchased as never,
    ),
    free,
    purchased,
  };
}

const base = {
  shopId: "shop-1",
  sourceKey: "recovery:shop-1:recovery-1",
};

describe("RecoveryDurableCreditAdmissionService", () => {
  it("keeps a lifetime-funded replay owned by lifetime Free capacity", async () => {
    const h = harness({
      purchasedReserve: {
        kind: "already-reserved" as const,
        reservation: {},
        counter: "LIFETIME_FREE_RECOVERY_CREDITS" as const,
      },
    });

    await expect(
      h.service.admitPurchased({ ...base, policy: freePolicy() }),
    ).resolves.toMatchObject({
      kind: "admitted",
      admission: { kind: "lifetime-free" },
    });
    expect(h.free.reserve).not.toHaveBeenCalled();
  });

  it("reactivates a released lifetime replay through the lifetime owner", async () => {
    const h = harness({
      purchasedReserve: {
        kind: "already-released" as const,
        reservation: {},
        counter: "LIFETIME_FREE_RECOVERY_CREDITS" as const,
      },
      freeReserve: {
        kind: "reserved" as const,
        reservation: {},
        counter: "LIFETIME_FREE_RECOVERY_CREDITS" as const,
      },
    });

    await expect(
      h.service.admitPurchased({ ...base, policy: freePolicy() }),
    ).resolves.toMatchObject({
      kind: "admitted",
      admission: { kind: "lifetime-free" },
    });
    expect(h.free.reserve).toHaveBeenCalledWith(base);
  });

  it("reactivates a post-contract lifetime replay through reservePostContract", async () => {
    const h = harness({
      purchasedReserve: {
        kind: "already-released" as const,
        reservation: {},
        counter: "LIFETIME_FREE_RECOVERY_CREDITS" as const,
      },
      freeReservePostContract: {
        kind: "reserved" as const,
        reservation: {},
        counter: "LIFETIME_FREE_RECOVERY_CREDITS" as const,
      },
    });

    await expect(
      h.service.admitPurchased({ ...base, policy: postContractPolicy() }),
    ).resolves.toMatchObject({
      kind: "admitted",
      admission: { kind: "lifetime-free" },
    });
    expect(h.free.reservePostContract).toHaveBeenCalledWith(base);
    expect(h.free.reserve).not.toHaveBeenCalled();
  });

  it("keeps a purchased-funded replay owned by purchased capacity", async () => {
    const h = harness({
      freeReserve: {
        kind: "already-reserved" as const,
        reservation: {},
        counter: "PURCHASED_RECOVERY_CREDITS" as const,
      },
    });

    await expect(
      h.service.admitLifetimeFree({ ...base, policy: freePolicy() }),
    ).resolves.toMatchObject({
      kind: "admitted",
      admission: { kind: "purchased" },
    });
    expect(h.purchased.reserve).not.toHaveBeenCalled();
  });

  it("reactivates a released purchased replay through the purchased owner", async () => {
    const h = harness({
      freeReserve: {
        kind: "already-released" as const,
        reservation: {},
        counter: "PURCHASED_RECOVERY_CREDITS" as const,
      },
      purchasedReserve: {
        kind: "reserved" as const,
        reservation: {},
        counter: "PURCHASED_RECOVERY_CREDITS" as const,
      },
    });

    await expect(
      h.service.admitLifetimeFree({ ...base, policy: freePolicy() }),
    ).resolves.toMatchObject({
      kind: "admitted",
      admission: { kind: "purchased" },
    });
    expect(h.purchased.reserve).toHaveBeenCalledWith(base);
  });

  it("does not reactivate a released purchased replay through a different capacity entry", async () => {
    const h = harness({
      purchasedReserve: {
        kind: "already-released" as const,
        reservation: {},
        counter: "PURCHASED_RECOVERY_CREDITS" as const,
      },
    });

    await expect(
      h.service.admitPurchased({ ...base, policy: freePolicy() }),
    ).resolves.toEqual({ kind: "blocked", reason: "reservation-in-flight" });
    expect(h.free.reserve).not.toHaveBeenCalled();
  });

  it("does not reactivate a released lifetime replay from the lifetime entry itself", async () => {
    const h = harness({
      freeReserve: {
        kind: "already-released" as const,
        reservation: {},
        counter: "LIFETIME_FREE_RECOVERY_CREDITS" as const,
      },
    });

    await expect(
      h.service.admitLifetimeFree({ ...base, policy: freePolicy() }),
    ).resolves.toEqual({ kind: "blocked", reason: "reservation-in-flight" });
    expect(h.purchased.reserve).not.toHaveBeenCalled();
  });

  it.each([
    {
      entry: "purchased" as const,
      outcome: {
        kind: "already-ambiguous" as const,
        reservation: {},
        counter: "LIFETIME_FREE_RECOVERY_CREDITS" as const,
      },
    },
    {
      entry: "lifetime" as const,
      outcome: {
        kind: "already-ambiguous" as const,
        reservation: {},
        counter: "PURCHASED_RECOVERY_CREDITS" as const,
      },
    },
  ])("blocks ambiguous replay ownership from $entry entry", async ({ entry, outcome }) => {
    const h = harness(
      entry === "purchased" ? { purchasedReserve: outcome } : { freeReserve: outcome },
    );
    const result = entry === "purchased"
      ? h.service.admitPurchased({ ...base, policy: freePolicy() })
      : h.service.admitLifetimeFree({ ...base, policy: freePolicy() });

    await expect(result).resolves.toEqual({
      kind: "blocked",
      reason: "reservation-in-flight",
    });
  });

  it("propagates a paused lifetime reservation as paused", async () => {
    const h = harness({ freeReserve: { kind: "paused" as const } });

    await expect(
      h.service.admitLifetimeFree({ ...base, policy: freePolicy() }),
    ).resolves.toEqual({ kind: "blocked", reason: "paused" });
  });
});
