import { describe, expect, it } from "vitest";

import {
  capacityHarness,
  postContractPolicy,
} from "./recovery-capacity-admission.test-support.js";

describe("RecoveryCapacityAdmissionService post-contract routing", () => {
  it("uses purchased credits first after a verified contract end", async () => {
    const h = capacityHarness({
      purchasedReserve: {
        kind: "reserved" as const,
        reservation: {},
        counter: "PURCHASED_RECOVERY_CREDITS" as const,
      },
    });

    await expect(
      h.service.admitPostContract({
        shopId: "shop-1",
        sourceKey: "recovery:shop-1:post-contract",
        policy: postContractPolicy(),
      }),
    ).resolves.toMatchObject({
      kind: "admitted",
      admission: { kind: "purchased" },
    });
    expect(h.purchased.reserve).toHaveBeenCalledOnce();
    expect(h.free.reservePostContract).not.toHaveBeenCalled();
    expect(h.paid.reserve).not.toHaveBeenCalled();
    expect(h.promotional.reserve).not.toHaveBeenCalled();
  });

  it("falls back to lifetime Free after purchased credits are exhausted", async () => {
    const h = capacityHarness({
      freeReservePostContract: {
        kind: "reserved" as const,
        reservation: {},
        counter: "LIFETIME_FREE_RECOVERY_CREDITS" as const,
      },
    });

    await expect(
      h.service.admitPostContract({
        shopId: "shop-1",
        sourceKey: "recovery:shop-1:post-contract",
        policy: postContractPolicy(),
      }),
    ).resolves.toMatchObject({
      kind: "admitted",
      admission: { kind: "lifetime-free" },
    });
    expect(h.purchased.reserve).toHaveBeenCalledOnce();
    expect(h.free.reservePostContract).toHaveBeenCalledOnce();
    expect(h.free.reserve).not.toHaveBeenCalled();
  });

  it("does not use promotional or Paid included capacity post-contract", async () => {
    const h = capacityHarness();

    await expect(
      h.service.admitPostContract({
        shopId: "shop-1",
        sourceKey: "recovery:shop-1:post-contract",
        policy: postContractPolicy(),
      }),
    ).resolves.toEqual({ kind: "blocked", reason: "capacity-exhausted" });
    expect(h.paid.reserve).not.toHaveBeenCalled();
    expect(h.promotional.reserve).not.toHaveBeenCalled();
  });

  it("blocks paused post-contract recovery before reserving durable credits", async () => {
    const h = capacityHarness();

    await expect(
      h.service.admitPostContract({
        shopId: "shop-1",
        sourceKey: "recovery:shop-1:post-contract",
        policy: postContractPolicy({ newRecoveriesPaused: true }),
      }),
    ).resolves.toEqual({ kind: "blocked", reason: "paused" });
    expect(h.purchased.reserve).not.toHaveBeenCalled();
    expect(h.free.reservePostContract).not.toHaveBeenCalled();
  });
});
