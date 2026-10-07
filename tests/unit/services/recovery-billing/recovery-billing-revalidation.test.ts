import { describe, expect, it, vi } from "vitest";

import { RecoveryBillingService } from "../../../../src/services/recovery-billing.service.js";
import { EffectiveBillingPolicyError } from "../../../../src/services/effective-billing-policy.service.js";
import { PostContractRecoveryPolicyError } from "../../../../src/services/post-contract-recovery-policy.service.js";
import type { RecoveryBillingAdmission } from "../../../../src/services/recovery-billing/recovery-billing.types.js";
import {
  paidPolicy,
  postContractPolicy,
} from "./recovery-capacity-admission.test-support.js";

function reservationHarness() {
  const free = {
    reserve: vi.fn(async () => ({ kind: "allowance-exhausted" as const, remaining: 0 })),
    reservePostContract: vi.fn(async () => ({ kind: "allowance-exhausted" as const, remaining: 0 })),
    commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn(),
  };
  const purchased = {
    reserve: vi.fn(async () => ({ kind: "credits-exhausted" as const, available: 0 })),
    commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn(),
  };
  const paid = {
    reserve: vi.fn(async ({ recoveryId }: { recoveryId?: string }) => ({
      kind: "reserved" as const,
      reservation: {},
      counter: "INCLUDED_RECOVERY_CREDITS" as const,
      sourceKey: `paid-included:period-1:${recoveryId}`,
      policy: paidPolicy(),
    })),
    commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn(),
  };
  const promotional = {
    reserve: vi.fn(async () => ({ kind: "unavailable" as const })),
    commit: vi.fn(), release: vi.fn(), markAmbiguous: vi.fn(),
  };
  return { free, purchased, paid, promotional };
}

function service(input: {
  resolve: () => Promise<unknown>;
  postContractResolve?: () => Promise<unknown>;
  reservations?: ReturnType<typeof reservationHarness>;
}) {
  const reservations = input.reservations ?? reservationHarness();
  return {
    service: new RecoveryBillingService(
      {} as never,
      { resolve: vi.fn(input.resolve) } as never,
      reservations.free as never,
      reservations.purchased as never,
      reservations.paid as never,
      reservations.promotional as never,
      {
        resolve: vi.fn(
          input.postContractResolve ?? (async () => postContractPolicy()),
        ),
      } as never,
    ),
    reservations,
  };
}

function admission(
  kind: RecoveryBillingAdmission["kind"],
  policy: unknown = paidPolicy(),
): RecoveryBillingAdmission {
  return { kind, sourceKey: `source:${kind}`, policy } as never;
}

describe("RecoveryBillingService pre-provider revalidation", () => {
  it("preserves Paid included admission while the same period remains ACTIVE", async () => {
    const h = service({ resolve: async () => paidPolicy("ACTIVE") });
    const current = admission("paid");

    await expect(
      h.service.revalidateBeforeProvider({ admission: current, recoveryId: "recovery-1" }),
    ).resolves.toEqual({ kind: "admitted", admission: current });
    expect(h.reservations.paid.release).not.toHaveBeenCalled();
  });

  it.each(["paid", "purchased", "free", "lifetime-free", "promotional"] as const)(
    "releases %s capacity when new recoveries become paused",
    async (kind) => {
      const h = service({
        resolve: async () => ({ ...paidPolicy(), newRecoveriesPaused: true }),
      });

      await expect(
        h.service.revalidateBeforeProvider({
          admission: admission(kind),
          recoveryId: "recovery-1",
        }),
      ).resolves.toEqual({ kind: "blocked", reason: "paused" });
    },
  );

  it("keeps purchased durable credit admitted after a verified contract end", async () => {
    const h = service({
      resolve: async () => {
        throw new EffectiveBillingPolicyError("NO_CONTRACT", "ended");
      },
    });
    const current = admission("purchased", postContractPolicy());

    await expect(
      h.service.revalidateBeforeProvider({ admission: current, recoveryId: "recovery-1" }),
    ).resolves.toEqual({ kind: "admitted", admission: current });
    expect(h.reservations.purchased.release).not.toHaveBeenCalled();
  });

  it("releases non-durable plan capacity when the contract ends", async () => {
    const h = service({
      resolve: async () => {
        throw new EffectiveBillingPolicyError("NO_CONTRACT", "ended");
      },
      postContractResolve: async () => {
        throw new PostContractRecoveryPolicyError("CONTRACT_REQUIRED", "required");
      },
    });

    await expect(
      h.service.revalidateBeforeProvider({
        admission: admission("paid"),
        recoveryId: "recovery-1",
      }),
    ).resolves.toEqual({ kind: "blocked", reason: "contract-required" });
    expect(h.reservations.paid.release).toHaveBeenCalledOnce();
  });

  it("releases and freshly re-admits Paid capacity when the billing period changes", async () => {
    const reservations = reservationHarness();
    reservations.paid.reserve.mockResolvedValue({
      kind: "reserved" as const,
      reservation: {},
      counter: "INCLUDED_RECOVERY_CREDITS" as const,
      sourceKey: "paid-included:period-2:recovery-1",
      policy: paidPolicy("ACTIVE", { billingPeriod: { id: "period-2", phase: "ACTIVE" } }),
    });
    const h = service({
      resolve: async () => paidPolicy("ACTIVE", { billingPeriod: { id: "period-2", phase: "ACTIVE" } }),
      reservations,
    });

    await expect(
      h.service.revalidateBeforeProvider({
        admission: admission("paid", paidPolicy("ACTIVE")),
        recoveryId: "recovery-1",
      }),
    ).resolves.toMatchObject({ kind: "admitted", admission: { kind: "paid" } });
    expect(reservations.paid.release).toHaveBeenCalledOnce();
    expect(reservations.paid.reserve).toHaveBeenCalledOnce();
  });

  it("releases ACTIVE Paid capacity and uses DRAINING durable fallback order once", async () => {
    const reservations = reservationHarness();
    const h = service({ resolve: async () => paidPolicy("DRAINING"), reservations });

    await expect(
      h.service.revalidateBeforeProvider({
        admission: admission("paid"),
        recoveryId: "recovery-1",
      }),
    ).resolves.toEqual({ kind: "blocked", reason: "billing-period-closing" });
    expect(reservations.paid.release).toHaveBeenCalledOnce();
    expect(reservations.paid.reserve).not.toHaveBeenCalled();
    expect(reservations.purchased.reserve).toHaveBeenCalledOnce();
    expect(reservations.free.reserve).toHaveBeenCalledOnce();
  });

  it.each(["paid", "purchased"] as const)(
    "releases %s capacity during EXPIRED_RECONCILING",
    async (kind) => {
      const h = service({ resolve: async () => paidPolicy("ACTIVE", { billingPeriod: { id: "period-1", phase: "EXPIRED_RECONCILING" } }) });

      await expect(
        h.service.revalidateBeforeProvider({
          admission: admission(kind),
          recoveryId: "recovery-1",
        }),
      ).resolves.toEqual({
        kind: "blocked",
        reason: "billing-period-reconciliation",
      });
      expect(h.reservations[kind === "paid" ? "paid" : "purchased"].release).toHaveBeenCalledOnce();
    },
  );
});
