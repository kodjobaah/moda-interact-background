import { describe, expect, it, vi } from "vitest";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";

import {
  RecoveryCreditNotCommittedError,
  RecoveryReservationLifecycleService,
} from "../../../../src/services/recovery-billing/recovery-reservation-lifecycle.service.js";
import type { RecoveryBillingAdmission } from "../../../../src/services/recovery-billing/recovery-billing.types.js";

function lifecycleService(serviceLogger?: StructuredLogger) {
  const commit = (kind: string) => vi.fn(async (input: { shopId: string; sourceKey: string }) => ({
    kind: "committed" as const,
    reservation: {
      id: `reservation-${kind}`,
      shopId: input.shopId,
      sourceKey: input.sourceKey,
      quantity: 1,
      status: "COMMITTED",
      committedUsageEventId: `usage-${kind}`,
    },
  }));
  const free = { commit: commit("free"), release: vi.fn(), markAmbiguous: vi.fn() };
  const purchased = { commit: commit("purchased"), release: vi.fn(), markAmbiguous: vi.fn() };
  const paid = { commit: commit("paid"), release: vi.fn(), markAmbiguous: vi.fn() };
  const promotional = { commit: commit("promotional"), release: vi.fn(), markAmbiguous: vi.fn() };

  return {
    service: new RecoveryReservationLifecycleService(
      free as never,
      purchased as never,
      paid as never,
      promotional as never,
      serviceLogger,
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

  it("rejects an owner result that does not prove a committed reservation", async () => {
    const harness = lifecycleService();
    harness.free.commit.mockResolvedValue(undefined as never);

    await expect(harness.service.commit({
      admission: admission("free"),
      occurredAt: new Date("2026-10-07T12:00:00.000Z"),
    })).rejects.toMatchObject<Partial<RecoveryCreditNotCommittedError>>({
      name: "RecoveryCreditNotCommittedError",
      shopId: "shop-1",
      sourceKey: "source:free",
      sourceKind: "free",
      outcomeKind: null,
      reservationStatus: null,
    });
  });

  it("emits the nonpositive legacy commit failure through the installed Shared logger", async () => {
    const records: string[] = [];
    const serviceLogger = createLogger({
      serviceName: "moda-recovery-worker",
      environment: "test",
      sink: (record) => records.push(JSON.stringify(record)),
    });
    const harness = lifecycleService(serviceLogger);
    harness.free.commit.mockResolvedValue(undefined as never);

    await expect(harness.service.commit({
      admission: admission("free"),
      occurredAt: new Date("2026-10-07T12:00:00.000Z"),
    })).rejects.toBeInstanceOf(RecoveryCreditNotCommittedError);

    const [record] = records.map((entry) => JSON.parse(entry) as {
      event: string;
      level: string;
      "service.name": string;
      "deployment.environment.name": string;
      data: Record<string, unknown>;
    });
    expect(record).toMatchObject({
      event: "recovery.credit_commit.failed",
      level: "error",
      "service.name": "moda-recovery-worker",
      "deployment.environment.name": "test",
      data: {
        operation: "commitSuccessfulInitiation",
        sourceKind: "free",
        shopId: "shop-1",
        sourceKey: "source:free",
        error: {
          name: "RecoveryCreditNotCommittedError",
          message: "Recovery reservation owner did not confirm a committed credit",
        },
      },
    });
    expect(record.data).not.toHaveProperty("providerError");
  });

  it("preserves an owner exception when the Shared logging sink throws", async () => {
    const injectedError = new Error("owner diagnostic sentinel");
    const serviceLogger = createLogger({
      serviceName: "moda-recovery-worker",
      environment: "test",
      sink: () => { throw new Error("sink failure"); },
    });
    const harness = lifecycleService(serviceLogger);
    harness.free.commit.mockRejectedValue(injectedError);

    await expect(harness.service.commit({
      admission: admission("free"),
      occurredAt: new Date("2026-10-07T12:00:00.000Z"),
    })).rejects.toBe(injectedError);
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
