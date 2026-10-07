import { describe, expect, it, vi } from "vitest";

import { RecoveryReservationLifecycleService } from "../../../../src/services/recovery-billing/recovery-reservation-lifecycle.service.js";
import type { RecoveryBillingAdmission } from "../../../../src/services/recovery-billing/recovery-billing.types.js";

function lifecycleService() {
  const free = { commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
  const purchased = { commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
  const paid = { commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };
  const promotional = { commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn() };

  return {
    service: new RecoveryReservationLifecycleService(
      free as never,
      purchased as never,
      paid as never,
      promotional as never,
    ),
    free,
    purchased,
    paid,
    promotional,
  };
}

function paidPolicy() {
  return {
    shopId: "shop-1",
    planId: "plan-1",
    planKind: "PAID_METERED" as const,
    features: new Set(["checkout_recovery"]),
    newRecoveriesPaused: false,
    billingPeriod: { id: "period-1", phase: "ACTIVE" as const },
  } as never;
}

function freePolicy() {
  return {
    shopId: "shop-1",
    subscriptionId: "subscription-1",
    planId: "plan-1",
    planKind: "FREE" as const,
    features: new Set(["checkout_recovery"]),
    newRecoveriesPaused: false,
  } as never;
}

function postContractPolicy() {
  return {
    mode: "POST_CONTRACT_DURABLE_CREDITS" as const,
    shopId: "shop-1",
    newRecoveriesPaused: false,
  } as never;
}

function admission(kind: RecoveryBillingAdmission["kind"]): RecoveryBillingAdmission {
  const sourceKey = `source:${kind}`;
  switch (kind) {
    case "promotional":
      return { kind, sourceKey, policy: paidPolicy() };
    case "paid":
      return { kind, sourceKey, policy: paidPolicy() };
    case "purchased":
      return { kind, sourceKey, policy: postContractPolicy() };
    case "free":
      return { kind, sourceKey, policy: freePolicy() };
    case "lifetime-free":
      return { kind, sourceKey, policy: postContractPolicy() };
  }
}

function providerError(code: string) {
  return Object.assign(new Error(code), {
    name: "WhatsAppServiceError",
    code,
  });
}

describe("RecoveryReservationLifecycleService", () => {
  it.each([
    ["free", "free"],
    ["lifetime-free", "free"],
    ["purchased", "purchased"],
  ] as const)("commits %s capacity through its reservation owner", async (kind, owner) => {
    const harness = lifecycleService();
    await harness.service.commit({
      admission: admission(kind),
      occurredAt: new Date("2026-10-07T12:00:00.000Z"),
    });

    expect(harness[owner].commit).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: `source:${kind}`,
    });
    expect(harness.paid.commit).not.toHaveBeenCalled();
    expect(harness.promotional.commit).not.toHaveBeenCalled();
  });

  it("commits Paid included capacity with the successful provider-initiation time", async () => {
    const harness = lifecycleService();
    const occurredAt = new Date("2026-10-07T12:34:56.000Z");

    await harness.service.commit({ admission: admission("paid"), occurredAt });

    expect(harness.paid.commit).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "source:paid",
      occurredAt,
    });
  });

  it("commits promotional capacity through the exact-plan grant owner", async () => {
    const harness = lifecycleService();
    await harness.service.commit({
      admission: admission("promotional"),
      occurredAt: new Date("2026-10-07T12:00:00.000Z"),
    });

    expect(harness.promotional.commit).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "source:promotional",
      planId: "plan-1",
    });
  });

  it.each([
    ["free", "free"],
    ["lifetime-free", "free"],
    ["purchased", "purchased"],
    ["paid", "paid"],
  ] as const)("releases %s capacity through its reservation owner", async (kind, owner) => {
    const harness = lifecycleService();
    await harness.service.release(admission(kind));

    expect(harness[owner].release).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: `source:${kind}`,
    });
  });

  it("releases promotional capacity with the frozen plan identity", async () => {
    const harness = lifecycleService();
    await harness.service.release(admission("promotional"));

    expect(harness.promotional.release).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "source:promotional",
      planId: "plan-1",
    });
  });

  it.each(["configuration-missing", "provider-rejected"])(
    "treats WhatsApp %s as definitive and releases the reservation",
    async (code) => {
      const harness = lifecycleService();
      const result = await harness.service.handleProviderFailure({
        admission: admission("paid"),
        error: providerError(code),
      });

      expect(result).toBe("definitive");
      expect(harness.paid.release).toHaveBeenCalledWith({
        shopId: "shop-1",
        sourceKey: "source:paid",
      });
      expect(harness.paid.markAmbiguous).not.toHaveBeenCalled();
    },
  );

  it.each([
    providerError("invalid-provider-response"),
    Object.assign(new Error("timeout"), { name: "TimeoutError" }),
    new Error("transport uncertainty"),
  ])("treats uncertain provider outcomes as ambiguous", async (error) => {
    const harness = lifecycleService();
    const result = await harness.service.handleProviderFailure({
      admission: admission("purchased"),
      error,
    });

    expect(result).toBe("ambiguous");
    expect(harness.purchased.markAmbiguous).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: "source:purchased",
    });
    expect(harness.purchased.release).not.toHaveBeenCalled();
  });

  it.each([
    ["free", "free"],
    ["lifetime-free", "free"],
    ["purchased", "purchased"],
    ["paid", "paid"],
  ] as const)("keeps ambiguous %s capacity attached to its exact owner", async (kind, owner) => {
    const harness = lifecycleService();
    await harness.service.handleProviderFailure({
      admission: admission(kind),
      error: providerError("invalid-provider-response"),
    });

    expect(harness[owner].markAmbiguous).toHaveBeenCalledWith({
      shopId: "shop-1",
      sourceKey: `source:${kind}`,
    });
    expect(harness[owner].release).not.toHaveBeenCalled();
  });

  it("keeps promotional definitive and ambiguous outcomes on the exact grant owner", async () => {
    const harness = lifecycleService();
    const promotional = admission("promotional");

    await harness.service.handleProviderFailure({
      admission: promotional,
      error: providerError("provider-rejected"),
    });
    await harness.service.handleProviderFailure({
      admission: promotional,
      error: providerError("invalid-provider-response"),
    });

    const reservationInput = {
      shopId: "shop-1",
      sourceKey: "source:promotional",
      planId: "plan-1",
    };
    expect(harness.promotional.release).toHaveBeenCalledWith(reservationInput);
    expect(harness.promotional.markAmbiguous).toHaveBeenCalledWith(reservationInput);
    expect(harness.free.release).not.toHaveBeenCalled();
    expect(harness.purchased.release).not.toHaveBeenCalled();
    expect(harness.paid.release).not.toHaveBeenCalled();
  });
});
