import { vi } from "vitest";

export function createDatabase(selectedGrant?: Record<string, unknown> | null) {
  const thread = { id: "thread-1" };
  const transactionMessageUpsert = vi.fn(async () => ({ id: "message-1" }));
  return {
    usageEvent: {
      upsert: vi.fn(async ({ create }: { create: unknown }) => ({
        id: "usage-1",
        ...create,
      })),
    },
    merchantSupportThread: {
      upsert: vi.fn(async () => thread),
      update: vi.fn(async () => thread),
    },
    merchantSupportMessage: {
      upsert: vi.fn(async () => ({ id: "message-1" })),
    },
    merchantPromotionSelection:
      selectedGrant === undefined
        ? undefined
        : {
            findUnique: vi.fn(async () =>
              selectedGrant ? { promotionalCreditGrant: selectedGrant } : null,
            ),
          },
    $transaction: vi.fn(async (callback: (transaction: unknown) => unknown) =>
      callback({
        merchantSupportThread: {
          upsert: vi.fn(async () => thread),
          update: vi.fn(async () => thread),
        },
        merchantSupportMessage: {
          upsert: transactionMessageUpsert,
        },
      }),
    ),
    transactionMessageUpsert,
  };
}

export function freePolicy() {
  return {
    shopId: "shop-1",
    subscriptionId: "subscription-1",
    planKind: "FREE" as const,
    features: new Set(["checkout_recovery"]),
    newRecoveriesPaused: false,
    freeAllowance: {
      grant: 5,
      effective: 5,
      committed: 5,
      reserved: 0,
      remaining: 0,
    },
  };
}

export function paidPolicy(
  phase: "ACTIVE" | "DRAINING" | "EXPIRED_RECONCILING" = "ACTIVE",
  periodId = "period-1",
) {
  return {
    shopId: "shop-1",
    planKind: "PAID_METERED" as const,
    features: new Set(["checkout_recovery"]),
    planId: "plan-1",
    newRecoveriesPaused: false,
    shopifyUsageEventHandle: "basic-recovery-conversation",
    billingPeriod: { id: periodId, phase },
  };
}

export function paidIncludedReservationService(
  outcome: "reserved" | "allowance-exhausted" = "reserved",
) {
  return {
    reserve: vi.fn(async ({ recoveryId }: { recoveryId: string }) =>
      outcome === "reserved"
        ? {
            kind: "reserved" as const,
            reservation: {},
            counter: "INCLUDED_RECOVERY_CREDITS" as const,
            sourceKey: `paid-included:${paidPolicy().billingPeriod?.id}:${recoveryId}`,
            policy: paidPolicy(),
          }
        : {
            kind: "allowance-exhausted" as const,
            remaining: 0,
            policy: paidPolicy(),
          },
    ),
    commit: vi.fn(),
    release: vi.fn(),
    markAmbiguous: vi.fn(),
  };
}

export function unavailablePromotionalReservationService() {
  return {
    reserve: vi.fn(async () => ({ kind: "unavailable" as const })),
    commit: vi.fn(),
    release: vi.fn(),
    markAmbiguous: vi.fn(),
  };
}
