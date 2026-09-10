import { describe, expect, it } from "vitest";

import { RecoveryCreditRefundService } from "../../../src/services/recovery-credit-refund.service.js";

function harness(options: {
  settlementMode?: string;
  available?: number;
  status?: string;
  correctionState?: string;
  correctionMismatch?: boolean;
  providerConfirmed?: boolean;
  failPurchaseCas?: boolean;
  failRefundCas?: boolean;
} = {}) {
  const refund = {
    id: "refund-1",
    shopId: "shop-1",
    purchaseId: "purchase-1",
    originalUsageEventIdSnapshot: "usage-1",
    billingPeriodIdSnapshot: "period-1",
    planHandleSnapshot: "pro-2026",
    eventHandleSnapshot: "pack-meter",
    creditsSnapshot: 5,
    settlementMode: options.settlementMode ?? "PARTNER_DASHBOARD_REFUND",
    status: options.status ?? "APPROVED",
    holdAppliedAt: null as Date | null,
    correctionUsageEventId: null as string | null,
    providerConfirmedAt: options.providerConfirmed ? new Date("2026-09-10T11:00:00.000Z") : null,
    providerConfirmedByPlatformAdminId: options.providerConfirmed ? "admin-1" : null,
    providerReference: options.providerConfirmed ? "provider-ref-1" : null,
    version: 0,
    purchase: {
      id: "purchase-1",
      shopId: "shop-1",
      status: "ACTIVE",
      creditsGranted: 5,
      shopifyPlanHandleSnapshot: "pro-2026",
      shopifyEventHandleSnapshot: "pack-meter",
      usageEvent: {
        id: "usage-1",
        shopId: "shop-1",
        billingPeriodId: "period-1",
        metric: "RECOVERY_CREDIT_PACK_PURCHASE",
        quantity: 1,
        shopifyReportState: "REPORTED",
        shopifyEventHandle: "pack-meter",
      },
    },
  };
  const counter = { id: "counter-1", grantedQuantity: options.available ?? 10, committedQuantity: 0, reservedQuantity: 0, refundingQuantity: 0, version: 0 };
  let correction: Record<string, unknown> | null = null;
  const database = {
    $transaction: async (callback: (transaction: typeof database) => Promise<unknown>) => {
      const snapshot = {
        refund: structuredClone(refund),
        purchase: structuredClone(refund.purchase),
        counter: structuredClone(counter),
        correction: correction ? structuredClone(correction) : null,
      };
      try {
        return await callback(database);
      } catch (error) {
        Object.assign(refund, snapshot.refund);
        Object.assign(refund.purchase, snapshot.purchase);
        Object.assign(counter, snapshot.counter);
        correction = snapshot.correction;
        throw error;
      }
    },
    recoveryCreditRefund: {
      findMany: async () => [refund],
      findUnique: async () => refund,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (where.status && typeof where.status === "string" && refund.status !== where.status) return { count: 0 };
        if (where.version !== undefined && refund.version !== where.version) return { count: 0 };
        if (options.failRefundCas && (where.status === "PROVIDER_CONFIRMED" || where.status === "REJECTED")) return { count: 0 };
        for (const [key, value] of Object.entries(data)) {
          if (key === "version" && typeof value === "object" && value && "increment" in value) refund.version += Number((value as { increment: number }).increment);
          else if (key === "attemptCount" && typeof value === "object" && value && "increment" in value) undefined;
          else (refund as Record<string, unknown>)[key] = value;
        }
        return { count: 1 };
      },
    },
    shopEntitlementCounter: {
      findUnique: async () => counter,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (where.version !== counter.version) return { count: 0 };
        for (const [key, value] of Object.entries(data)) {
          if (typeof value === "object" && value && "increment" in value) counter[key as keyof typeof counter] += Number((value as { increment: number }).increment);
          if (typeof value === "object" && value && "decrement" in value) counter[key as keyof typeof counter] -= Number((value as { decrement: number }).decrement);
        }
        counter.version += 1;
        return { count: 1 };
      },
    },
    usageEvent: {
      findUnique: async () => correction,
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        correction ??= { id: "correction-1", ...create, shopifyReportState: options.correctionState ?? "PENDING" };
        if (options.correctionMismatch) correction.shopId = "other-shop";
        return correction;
      },
    },
    subscription: {
      findUnique: async () => ({ billingPeriodId: "period-1", observedShopifyPlanHandle: "pro-2026", plan: { shopifyRecoveryCreditPackEventHandle: "pack-meter" } }),
    },
    recoveryCreditPurchase: {
      findUnique: async () => refund.purchase,
      updateMany: async () => {
        if (options.failPurchaseCas) return { count: 0 };
        refund.purchase.status = "REFUNDED";
        return { count: 1 };
      },
    },
    merchantSupportThread: { upsert: async () => ({ id: "thread-1" }) },
    merchantSupportMessage: { upsert: async () => ({ id: "message-1" }) },
  };
  return { service: new RecoveryCreditRefundService(database as never, () => new Date("2026-09-10T12:00:00.000Z")), refund, purchase: refund.purchase, counter, get correction() { return correction; } };
}

describe("RecoveryCreditRefundService", () => {
  it("holds the full pack, keeps it active, and finalizes a dashboard refund once", async () => {
    const test = harness();
    await expect(test.service.processDue()).resolves.toMatchObject({ held: 1, actionRequired: 1 });
    expect(test.counter.refundingQuantity).toBe(5);
    expect(test.purchase.status).toBe("ACTIVE");

    test.refund.status = "PROVIDER_CONFIRMED";
    test.refund.providerConfirmedAt = new Date();
    test.refund.providerConfirmedByPlatformAdminId = "admin-1";
    test.refund.providerReference = "provider-ref-1";
    await expect(test.service.processDue()).resolves.toMatchObject({ completed: 1 });
    expect(test.counter.grantedQuantity).toBe(5);
    expect(test.counter.refundingQuantity).toBe(0);
    expect(test.purchase.status).toBe("REFUNDED");
    await expect(test.service.processDue()).resolves.toMatchObject({ completed: 0 });
    expect(test.counter.grantedQuantity).toBe(5);
  });

  it("creates one correction and waits for provider reporting before action", async () => {
    const test = harness({ settlementMode: "CURRENT_CYCLE_APP_EVENT_CORRECTION" });
    await expect(test.service.processDue()).resolves.toMatchObject({ held: 1, pending: 1 });
    expect(test.correction).toMatchObject({ quantity: -1, correctionOfUsageEventId: "usage-1" });
    expect(test.correction).toMatchObject({
      metric: "RECOVERY_CREDIT_PACK_PURCHASE",
      billingPeriodId: "period-1",
      sourceType: "RECOVERY_CREDIT_REFUND",
      sourceId: "refund-1",
      idempotencyKey: "recovery-credit-refund:refund-1",
      shopifyEventHandle: "pack-meter",
    });
    test.correction!.shopifyReportState = "REPORTED";
    await expect(test.service.processDue()).resolves.toMatchObject({ actionRequired: 1 });
    await expect(test.service.processDue()).resolves.toMatchObject({ actionRequired: 1 });
    expect(test.refund.correctionUsageEventId).toBe("correction-1");
  });

  it("does not apply a hold when the available balance is insufficient", async () => {
    const test = harness({ available: 4 });
    await expect(test.service.processDue()).resolves.toMatchObject({ attention: 1 });
    expect(test.refund.status).toBe("NEEDS_ATTENTION");
    expect(test.counter.refundingQuantity).toBe(0);
  });

  it("automatically releases an explicit rejected hold without changing its terminal status", async () => {
    const test = harness({ status: "REJECTED" });
    test.refund.holdAppliedAt = new Date();
    test.counter.refundingQuantity = 5;

    await expect(test.service.processDue()).resolves.toMatchObject({ held: 1 });

    expect(test.refund.status).toBe("REJECTED");
    expect(test.refund.holdAppliedAt).toBeNull();
    expect(test.counter.refundingQuantity).toBe(0);
  });

  it("does not hold more credits than purchased availability", async () => {
    const test = harness({ available: 4 });

    await expect(test.service.processDue()).resolves.toMatchObject({ attention: 1 });

    expect(test.counter.refundingQuantity).toBe(0);
    expect(test.refund.holdAppliedAt).toBeNull();
  });

  it("does not release a terminal hold after provider action or correction exists", async () => {
    const test = harness({ status: "REJECTED" });
    test.refund.holdAppliedAt = new Date();
    test.refund.correctionUsageEventId = "correction-1";
    test.counter.refundingQuantity = 5;

    await expect(test.service.processDue()).resolves.toMatchObject({ scanned: 1, held: 0 });

    expect(test.counter.refundingQuantity).toBe(5);
    expect(test.refund.holdAppliedAt).not.toBeNull();
  });

  it("requires complete provider confirmation evidence before finalization", async () => {
    const test = harness({ status: "PROVIDER_CONFIRMED" });
    test.refund.holdAppliedAt = new Date();
    test.counter.refundingQuantity = 5;

    await expect(test.service.processDue()).resolves.toMatchObject({ completed: 0 });

    expect(test.counter.grantedQuantity).toBe(10);
    expect(test.purchase.status).toBe("ACTIVE");
  });

  it("rolls back counter accounting when the purchase CAS loses", async () => {
    const test = harness({ status: "PROVIDER_CONFIRMED", providerConfirmed: true, failPurchaseCas: true });
    test.refund.holdAppliedAt = new Date();
    test.counter.refundingQuantity = 5;

    await expect(test.service.processDue()).rejects.toThrow();

    expect(test.counter.grantedQuantity).toBe(10);
    expect(test.counter.refundingQuantity).toBe(5);
    expect(test.purchase.status).toBe("ACTIVE");
    expect(test.refund.status).toBe("PROVIDER_CONFIRMED");
  });

  it("rolls back hold release when the terminal refund CAS loses", async () => {
    const test = harness({ status: "REJECTED", failRefundCas: true });
    test.refund.holdAppliedAt = new Date();
    test.counter.refundingQuantity = 5;

    await expect(test.service.processDue()).rejects.toThrow();

    expect(test.counter.refundingQuantity).toBe(5);
    expect(test.refund.status).toBe("REJECTED");
    expect(test.refund.holdAppliedAt).not.toBeNull();
  });

  it.each([
    ["PENDING", "pending"],
    ["IN_FLIGHT", "pending"],
    ["RETRYABLE", "pending"],
    ["REPORTED", "action"],
    ["NEEDS_ATTENTION", "attention"],
    ["NOT_APPLICABLE", "attention"],
  ] as const)("maps linked correction state %s explicitly", async (correctionState, outcome) => {
    const test = harness({ settlementMode: "CURRENT_CYCLE_APP_EVENT_CORRECTION", correctionState });
    const result = await test.service.processDue();

    expect(result[outcome === "pending" ? "pending" : outcome === "action" ? "actionRequired" : "attention"]).toBe(1);
    expect(test.refund.status).toBe(
      outcome === "pending" ? "PROVIDER_PENDING" : outcome === "action" ? "PROVIDER_ACTION_REQUIRED" : "NEEDS_ATTENTION",
    );
  });

  it("fails closed when an existing correction identity is inconsistent", async () => {
    const test = harness({ settlementMode: "CURRENT_CYCLE_APP_EVENT_CORRECTION", correctionMismatch: true });

    await expect(test.service.processDue()).resolves.toMatchObject({ attention: 1 });

    expect(test.refund.status).toBe("NEEDS_ATTENTION");
    expect(test.refund.holdAppliedAt).not.toBeNull();
  });
});