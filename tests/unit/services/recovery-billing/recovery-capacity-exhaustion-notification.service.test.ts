import { describe, expect, it, vi } from "vitest";

import { RecoveryCapacityExhaustionNotificationService } from "../../../../src/services/recovery-billing/recovery-capacity-exhaustion-notification.service.js";

function freePolicy(overrides: Record<string, unknown> = {}) {
  return {
    shopId: "shop-1",
    subscriptionId: "subscription-1",
    subscriptionStatus: "ACTIVE",
    planId: "free-plan",
    planHandle: "free",
    planKind: "FREE",
    features: new Set(["checkout_recovery"]),
    freeAllowance: {
      grant: 5,
      effective: 5,
      committed: 5,
      reserved: 0,
      remaining: 0,
    },
    shopifyUsageEventHandle: null,
    billingPeriod: null,
    recoveryCreditPack: null,
    outboundSoftLimit: 1000,
    outboundHardLimit: 2000,
    terminalMessageReservedSlots: 1,
    newRecoveriesPaused: false,
    automatedWhatsappPaused: false,
    paused: false,
    pauseReasons: [],
    policyVersions: {
      platform: 1,
      shopOverride: null,
      plan: new Date("2026-10-01T00:00:00.000Z"),
    },
    ...overrides,
  };
}

function paidPolicy() {
  return freePolicy({
    planId: "paid-plan",
    planHandle: "paid",
    planKind: "PAID_METERED",
    freeAllowance: null,
    shopifyUsageEventHandle: "recovery-usage",
    billingPeriod: {
      id: "period-1",
      shopId: "shop-1",
      subscriptionId: "subscription-1",
      start: new Date("2026-10-01T00:00:00.000Z"),
      end: new Date("2026-11-01T00:00:00.000Z"),
      status: "OPEN",
      phase: "ACTIVE",
      includedCounter: {
        id: "included-1",
        shopId: "shop-1",
        billingPeriodId: "period-1",
        grantedQuantity: 100,
        currentAllowanceQuantity: null,
        committedQuantity: 100,
        reservedQuantity: 0,
        forfeitedQuantity: 0,
      },
    },
    recoveryCreditPack: {
      enabled: true,
      creditsPerPack: 5,
      shopifyEventHandle: "recovery-pack",
      includedRecoveryConversationAllowance: null,
    },
  });
}

function createDatabase(options: {
  selectedGrant?: Record<string, unknown> | null;
  includedCounter?: Record<string, unknown> | null;
  purchasedCounter?: Record<string, unknown> | null;
} = {}) {
  const thread = { id: "thread-1" };
  const messages = new Map<string, { id: string }>();
  const messageUpsert = vi.fn(
    async ({ where }: { where: { sourceKey: string } }) => {
      const existing = messages.get(where.sourceKey);
      if (existing) return existing;
      const message = { id: `message-${messages.size + 1}` };
      messages.set(where.sourceKey, message);
      return message;
    },
  );
  const threadUpdate = vi.fn(async () => thread);

  return {
    shopEntitlementCounter: {
      findUnique: vi.fn(async () => options.purchasedCounter ?? null),
    },
    billingPeriodEntitlementCounter: {
      findUnique: vi.fn(async () => options.includedCounter ?? null),
    },
    merchantPromotionSelection: {
      findUnique: vi.fn(async () =>
        options.selectedGrant
          ? { promotionalCreditGrant: options.selectedGrant }
          : null,
      ),
    },
    merchantSupportThread: {
      upsert: vi.fn(async () => thread),
      update: threadUpdate,
    },
    merchantSupportMessage: { upsert: messageUpsert },
    $transaction: vi.fn(async (callback: (transaction: unknown) => unknown) =>
      callback({
        merchantSupportThread: {
          upsert: vi.fn(async () => thread),
          update: threadUpdate,
        },
        merchantSupportMessage: { upsert: messageUpsert },
      }),
    ),
    messageUpsert,
    messages,
    threadUpdate,
  };
}

describe("RecoveryCapacityExhaustionNotificationService", () => {
  it("writes the deterministic Free exhaustion SYSTEM message atomically", async () => {
    const database = createDatabase();
    const service = new RecoveryCapacityExhaustionNotificationService(
      database as never,
    );

    await service.notify("shop-1", freePolicy() as never);

    expect(database.$transaction).toHaveBeenCalledOnce();
    expect(database.messageUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          sourceKey:
            "billing-system:shop-1:BILLING_RECOVERY_CAPACITY_EXHAUSTED:FREE|subscription-1|no-period|5:5:0|no-included-counter|no-purchased-counter|no-selected-promotion|no-pack:1",
        },
        create: expect.objectContaining({
          kind: "SYSTEM",
          state: "AVAILABLE",
          systemCode: "BILLING_RECOVERY_CAPACITY_EXHAUSTED",
          sourceLanguageTag: "en-GB",
          originalBody: expect.stringContaining("Free-plan recovery-capacity"),
        }),
      }),
    );
    expect(database.threadUpdate).toHaveBeenCalledWith({
      where: { id: "thread-1" },
      data: { lastMessageAt: expect.any(Date) },
    });
  });

  it("deduplicates the same lifecycle and starts a new epoch when Free capacity changes", async () => {
    const database = createDatabase();
    const service = new RecoveryCapacityExhaustionNotificationService(
      database as never,
    );

    await service.notify("shop-1", freePolicy() as never);
    await service.notify("shop-1", freePolicy() as never);
    await service.notify(
      "shop-1",
      freePolicy({
        subscriptionId: "subscription-2",
        freeAllowance: {
          ...freePolicy().freeAllowance,
          grant: 4,
          effective: 4,
        },
      }) as never,
    );

    expect(database.messages.size).toBe(2);
    expect(database.messageUpsert).toHaveBeenCalledTimes(3);
    expect([...database.messages.keys()][0]).toContain(
      "FREE|subscription-1|no-period|5:5:0|no-included-counter|no-purchased-counter|no-selected-promotion|no-pack",
    );
    expect([...database.messages.keys()][1]).toContain(
      "FREE|subscription-2|no-period|4:5:0|no-included-counter|no-purchased-counter|no-selected-promotion|no-pack",
    );
  });

  it("includes the selected promotional grant snapshot in the exhaustion epoch", async () => {
    const database = createDatabase({
      selectedGrant: {
        id: "grant-1",
        version: 2,
        quantity: 10,
        committedQuantity: 10,
        reservedQuantity: 0,
      },
    });
    const service = new RecoveryCapacityExhaustionNotificationService(
      database as never,
    );

    await service.notify("shop-1", freePolicy() as never);

    expect([...database.messages.keys()][0]).toContain("grant-1:2:10:10:0");
  });

  it("deduplicates identical selected promotional grant snapshots", async () => {
    const database = createDatabase({
      selectedGrant: {
        id: "grant-1",
        version: 2,
        quantity: 10,
        committedQuantity: 10,
        reservedQuantity: 0,
      },
    });
    const service = new RecoveryCapacityExhaustionNotificationService(
      database as never,
    );

    await service.notify("shop-1", freePolicy() as never);
    await service.notify("shop-1", freePolicy() as never);

    expect(database.messages.size).toBe(1);
  });

  it.each([
    ["id", "grant-2"],
    ["version", 3],
    ["committedQuantity", 9],
    ["reservedQuantity", 1],
  ] as const)(
    "changes the selected promotional epoch when %s changes",
    async (field, value) => {
      const firstGrant = {
        id: "grant-1",
        version: 2,
        quantity: 10,
        committedQuantity: 10,
        reservedQuantity: 0,
      };
      let selectedGrant: Record<string, unknown> = firstGrant;
      const database = createDatabase();
      database.merchantPromotionSelection.findUnique.mockImplementation(
        async () => ({ promotionalCreditGrant: selectedGrant }),
      );
      const service = new RecoveryCapacityExhaustionNotificationService(
        database as never,
      );

      await service.notify("shop-1", freePolicy() as never);
      selectedGrant = { ...firstGrant, [field]: value };
      await service.notify("shop-1", freePolicy() as never);

      expect(database.messages.size).toBe(2);
    },
  );

  it("includes Paid included, purchased and pack state in the exhaustion epoch", async () => {
    const database = createDatabase({
      includedCounter: {
        grantedQuantity: 100,
        currentAllowanceQuantity: 100,
        committedQuantity: 100,
        reservedQuantity: 0,
        forfeitedQuantity: 0,
      },
      purchasedCounter: {
        grantedQuantity: 5,
        committedQuantity: 5,
        reservedQuantity: 0,
        refundingQuantity: 0,
      },
    });
    const service = new RecoveryCapacityExhaustionNotificationService(
      database as never,
    );

    await service.notify("shop-1", paidPolicy() as never);

    const sourceKey = [...database.messages.keys()][0];
    expect(sourceKey).toContain(
      "PAID_METERED|subscription-1|period-1|no-free-allowance|100:100:0:0|5:5:0:0|no-selected-promotion|recovery-pack",
    );
    expect(database.messageUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          originalBody: expect.stringContaining("Paid monthly included"),
        }),
      }),
    );
  });

  it("starts a new paid exhaustion epoch when current allowance changes", async () => {
    const database = createDatabase({
      includedCounter: {
        grantedQuantity: 100,
        currentAllowanceQuantity: 100,
        committedQuantity: 100,
        reservedQuantity: 0,
        forfeitedQuantity: 0,
      },
    });
    const service = new RecoveryCapacityExhaustionNotificationService(database as never);

    await service.notify("shop-1", paidPolicy() as never);
    database.billingPeriodEntitlementCounter.findUnique.mockResolvedValue({
      grantedQuantity: 100,
      currentAllowanceQuantity: 80,
      committedQuantity: 100,
      reservedQuantity: 0,
      forfeitedQuantity: 0,
    });
    await service.notify("shop-1", paidPolicy() as never);

    expect(database.messages.size).toBe(2);
    expect([...database.messages.keys()][0]).toContain("period-1|no-free-allowance|100:100:0:0");
    expect([...database.messages.keys()][1]).toContain("period-1|no-free-allowance|80:100:0:0");
  });
});
