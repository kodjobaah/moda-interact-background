import { describe, expect, it, vi } from "vitest";

import {
  ensureSuccessorBillingPeriod,
  findCompatibleSuccessorBillingPeriod,
} from "../../../../src/services/billing-period-transition/successor-billing-period.js";

const start = new Date("2026-10-01T00:00:00.000Z");
const end = new Date("2026-11-01T00:00:00.000Z");

const baseInput = {
  shopId: "shop-1",
  subscriptionId: "subscription-1",
  planId: "plan-paid",
  shopifyPlanHandleSnapshot: "paid-2026",
  planNameSnapshot: "Paid",
  planKindSnapshot: "PAID_METERED" as const,
  includedRecoveryCreditsGranted: 100,
  periodStart: start,
  periodEnd: end,
  errors: {
    closedPeriod: "closed successor",
    incompatiblePeriod: "incompatible successor",
    incompatibleIncludedCounter: "incompatible counter",
  },
};

function harness(options: {
  successor?: Record<string, unknown> | null;
  counter?: Record<string, unknown> | null;
} = {}) {
  const successor = options.successor === undefined ? null : options.successor;
  const transaction = {
    billingPeriod: {
      findUnique: vi.fn().mockResolvedValue(successor),
      create: vi.fn().mockResolvedValue({ id: "period-new" }),
    },
    billingPeriodEntitlementCounter: {
      findUnique: vi.fn().mockResolvedValue(options.counter ?? null),
      upsert: vi.fn(),
    },
  };
  return transaction;
}

function compatibleSuccessor(overrides: Record<string, unknown> = {}) {
  return {
    id: "period-new",
    shopId: "shop-1",
    subscriptionId: "subscription-1",
    planId: "plan-paid",
    shopifyPlanHandleSnapshot: "paid-2026",
    planNameSnapshot: "Paid",
    planKindSnapshot: "PAID_METERED",
    includedRecoveryCreditsGranted: 100,
    periodStart: start,
    periodEnd: end,
    status: "OPEN",
    ...overrides,
  };
}

describe("successor billing period", () => {
  it("creates an exact Paid successor and included-credit counter", async () => {
    const transaction = harness();

    const existing = await findCompatibleSuccessorBillingPeriod(transaction as never, baseInput);
    const period = await ensureSuccessorBillingPeriod(transaction as never, baseInput, existing);

    expect(period).toEqual({ id: "period-new" });
    expect(transaction.billingPeriod.create).toHaveBeenCalledWith({
      data: {
        shopId: "shop-1",
        subscriptionId: "subscription-1",
        planId: "plan-paid",
        shopifyPlanHandleSnapshot: "paid-2026",
        planNameSnapshot: "Paid",
        planKindSnapshot: "PAID_METERED",
        includedRecoveryCreditsGranted: 100,
        periodStart: start,
        periodEnd: end,
        status: "OPEN",
      },
    });
    expect(transaction.billingPeriodEntitlementCounter.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: {},
      create: expect.objectContaining({
        billingPeriodId: "period-new",
        grantedQuantity: 100,
        committedQuantity: 0,
        reservedQuantity: 0,
        forfeitedQuantity: 0,
      }),
    }));
  });

  it("reuses a compatible successor without resetting included usage", async () => {
    const existingCounter = {
      id: "counter-new",
      grantedQuantity: 100,
      committedQuantity: 7,
      reservedQuantity: 3,
      forfeitedQuantity: 2,
    };
    const transaction = harness({ successor: compatibleSuccessor(), counter: existingCounter });

    const existing = await findCompatibleSuccessorBillingPeriod(transaction as never, baseInput);
    const period = await ensureSuccessorBillingPeriod(transaction as never, baseInput, existing);

    expect(period).toEqual({ id: "period-new" });
    expect(transaction.billingPeriod.create).not.toHaveBeenCalled();
    expect(transaction.billingPeriodEntitlementCounter.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
    expect(existingCounter).toEqual({
      id: "counter-new",
      grantedQuantity: 100,
      committedQuantity: 7,
      reservedQuantity: 3,
      forfeitedQuantity: 2,
    });
  });

  it("rejects a closed successor with the caller-specific error", async () => {
    const transaction = harness({ successor: compatibleSuccessor({ status: "CLOSED" }) });

    await expect(findCompatibleSuccessorBillingPeriod(transaction as never, baseInput))
      .rejects.toThrow("closed successor");
  });

  it.each([
    ["shop", { shopId: "shop-2" }],
    ["subscription", { subscriptionId: "subscription-2" }],
    ["plan", { planId: "plan-other" }],
    ["handle", { shopifyPlanHandleSnapshot: "paid-other" }],
    ["name", { planNameSnapshot: "Paid Other" }],
    ["kind", { planKindSnapshot: "FREE" }],
    ["grant", { includedRecoveryCreditsGranted: 90 }],
    ["start", { periodStart: new Date("2026-10-02T00:00:00.000Z") }],
    ["end", { periodEnd: new Date("2026-11-02T00:00:00.000Z") }],
  ])("rejects an incompatible successor %s identity", async (_label, overrides) => {
    const transaction = harness({ successor: compatibleSuccessor(overrides) });

    await expect(findCompatibleSuccessorBillingPeriod(transaction as never, baseInput))
      .rejects.toThrow("incompatible successor");
  });

  it("rejects an incompatible existing included-credit grant", async () => {
    const transaction = harness({
      successor: compatibleSuccessor(),
      counter: { id: "counter-new", grantedQuantity: 99 },
    });

    const existing = await findCompatibleSuccessorBillingPeriod(transaction as never, baseInput);
    await expect(ensureSuccessorBillingPeriod(transaction as never, baseInput, existing))
      .rejects.toThrow("incompatible counter");
    expect(transaction.billingPeriodEntitlementCounter.upsert).not.toHaveBeenCalled();
  });

  it("creates a Free successor without an included-credit counter", async () => {
    const transaction = harness();
    const input = {
      ...baseInput,
      planId: "plan-free",
      shopifyPlanHandleSnapshot: "free-2026",
      planNameSnapshot: "Free",
      planKindSnapshot: "FREE" as const,
      includedRecoveryCreditsGranted: null,
    };

    const existing = await findCompatibleSuccessorBillingPeriod(transaction as never, input);
    await ensureSuccessorBillingPeriod(transaction as never, input, existing);

    expect(transaction.billingPeriodEntitlementCounter.findUnique).not.toHaveBeenCalled();
    expect(transaction.billingPeriodEntitlementCounter.upsert).not.toHaveBeenCalled();
  });
});
