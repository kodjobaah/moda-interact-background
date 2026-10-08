import { vi } from "vitest";

import { RecoveryCapacityAdmissionService } from "../../../../src/services/recovery-billing/recovery-capacity-admission.service.js";

export function freePolicy(overrides: Record<string, unknown> = {}) {
  return {
    shopId: "shop-1",
    subscriptionId: "subscription-1",
    planId: "free-plan",
    planKind: "FREE" as const,
    features: new Set(["checkout_recovery"]),
    newRecoveriesPaused: false,
    freeAllowance: {
      grant: 5,
      effective: 5,
      committed: 0,
      reserved: 0,
      remaining: 5,
    },
    ...overrides,
  } as never;
}

export function paidPolicy(
  phase: "ACTIVE" | "DRAINING" | "EXPIRED_RECONCILING" = "ACTIVE",
  overrides: Record<string, unknown> = {},
) {
  return {
    shopId: "shop-1",
    subscriptionId: "subscription-1",
    planId: "paid-plan",
    planKind: "PAID_METERED" as const,
    platform: "SHOPIFY",
    subscriptionStatus: "ACTIVE",
    features: new Set(["checkout_recovery"]),
    newRecoveriesPaused: false,
    shopifyUsageEventHandle: "recovery-conversation",
    billingPeriod: { id: "period-1", phase },
    ...overrides,
  } as never;
}

export function postContractPolicy(overrides: Record<string, unknown> = {}) {
  return {
    mode: "POST_CONTRACT_DURABLE_CREDITS" as const,
    shopId: "shop-1",
    subscriptionId: "subscription-1",
    subscriptionStatus: "NO_CONTRACT" as const,
    newRecoveriesPaused: false,
    automatedWhatsappPaused: false,
    outboundSoftLimit: 1000,
    outboundHardLimit: 2000,
    terminalMessageReservedSlots: 1,
    billingPeriod: null,
    ...overrides,
  } as never;
}

export function capacityHarness(overrides: {
  freeReserve?: unknown;
  freeReservePostContract?: unknown;
  purchasedReserve?: unknown;
  paidReserve?: unknown;
  promotionalReserve?: unknown;
} = {}) {
  const free = {
    reserve: vi.fn(async () =>
      overrides.freeReserve ?? {
        kind: "allowance-exhausted" as const,
        remaining: 0,
      },
    ),
    reservePostContract: vi.fn(async () =>
      overrides.freeReservePostContract ?? {
        kind: "allowance-exhausted" as const,
        remaining: 0,
      },
    ),
  };
  const purchased = {
    reserve: vi.fn(async () =>
      overrides.purchasedReserve ?? {
        kind: "credits-exhausted" as const,
        available: 0,
      },
    ),
  };
  const paid = {
    reserve: vi.fn(async ({ recoveryId, sourceKey }: { recoveryId?: string; sourceKey?: string }) =>
      overrides.paidReserve ?? {
        kind: "reserved" as const,
        reservation: {},
        counter: "INCLUDED_RECOVERY_CREDITS" as const,
        sourceKey: sourceKey ?? `paid-included:period-1:${recoveryId}`,
        policy: paidPolicy(),
      },
    ),
  };
  const promotional = {
    reserve: vi.fn(async ({ sourceKey }: { sourceKey: string }) =>
      overrides.promotionalReserve ?? { kind: "unavailable" as const, sourceKey },
    ),
  };

  return {
    service: new RecoveryCapacityAdmissionService(
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

export function normalInput(policy: unknown, overrides: Record<string, unknown> = {}) {
  return {
    shopId: "shop-1",
    recoveryId: "recovery-1",
    sourceKey: "recovery:shop-1:recovery-1",
    policy,
    ...overrides,
  } as never;
}
