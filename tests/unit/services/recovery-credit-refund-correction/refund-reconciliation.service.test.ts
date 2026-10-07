import {
  Prisma,
  RecoveryCreditPurchaseStatus,
  RecoveryCreditRefundStatus,
  ShopifyReportState,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { RefundReconciliationService } from "../../../../src/services/recovery-credit-refund-correction/refund-reconciliation.service.js";
import type { RefundRow } from "../../../../src/services/recovery-credit-refund-correction/refund-correction.types.js";

function linkedRefund(overrides: Partial<RefundRow> = {}): RefundRow {
  return {
    id: "refund-1",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    shopId: "shop-1",
    status: RecoveryCreditRefundStatus.REQUESTED,
    reason: null,
    purchaseId: "purchase-1",
    billingPeriodIdSnapshot: "period-1",
    providerSubscriptionIdSnapshot: "provider-context-1",
    planHandleSnapshot: "pro-2026",
    eventHandleSnapshot: "pack-meter",
    shopifyPartnerDevelopmentSnapshot: false,
    purchaseProviderAmountSnapshot: new Prisma.Decimal("1.00"),
    purchaseProviderCurrencySnapshot: "USD",
    finalCreditQuantity: 1,
    expectedProviderAmount: new Prisma.Decimal("1.00"),
    expectedProviderCurrency: "USD",
    automaticCorrectionUsageEventId: "correction-event-1",
    providerUsageQuantityBeforeCorrection: new Prisma.Decimal("1"),
    providerUsageCostBeforeCorrection: new Prisma.Decimal("1.00"),
    expectedProviderUsageQuantityAfterCorrection: new Prisma.Decimal("0"),
    expectedProviderUsageCostAfterCorrection: new Prisma.Decimal("0.00"),
    version: 0,
    purchase: {
      usageEventId: "purchase-event-1",
      status: RecoveryCreditPurchaseStatus.WITHDRAWN,
      currentAmount: 1,
      reservedAmount: 0,
      creditsGranted: 1,
    },
    shop: { shopifyShopId: "gid://shopify/Shop/1" },
    automaticCorrectionUsageEvent: {
      id: "correction-event-1",
      quantity: new Prisma.Decimal("-1"),
      correctionOfUsageEventId: "purchase-event-1",
      sourceType: "RECOVERY_CREDIT_REFUND",
      sourceId: "refund-1",
      shopifyEventHandle: "pack-meter",
      shopifyIdempotencyKey: "shopify-key",
      shopifyReportState: ShopifyReportState.REPORTED,
    },
    ...overrides,
  };
}

function harness() {
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const providerState = {
    read: vi.fn().mockResolvedValue({
      safe: true,
      quantity: new Prisma.Decimal("1"),
      cost: new Prisma.Decimal("1.00"),
      currency: "USD",
    }),
  };
  const completion = { complete: vi.fn().mockResolvedValue(true) };
  const database = { recoveryCreditRefund: { updateMany } };
  return {
    updateMany,
    providerState,
    completion,
    service: new RefundReconciliationService(
      database as never,
      providerState as never,
      completion as never,
    ),
  };
}

describe("RefundReconciliationService", () => {
  it("moves incomplete linked correction evidence to NEEDS_ATTENTION before provider proof", async () => {
    const test = harness();
    const refund = linkedRefund({
      automaticCorrectionUsageEvent: {
        ...linkedRefund().automaticCorrectionUsageEvent!,
        shopifyIdempotencyKey: null,
      },
    });

    await expect(test.service.reconcile(refund)).resolves.toBe("needs-attention");
    expect(test.providerState.read).not.toHaveBeenCalled();
    expect(test.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        status: RecoveryCreditRefundStatus.NEEDS_ATTENTION,
        reason: "automatic-correction-evidence-incomplete",
      },
    }));
  });

  it("propagates a linked provider NEEDS_ATTENTION state to the refund", async () => {
    const test = harness();
    const refund = linkedRefund({
      automaticCorrectionUsageEvent: {
        ...linkedRefund().automaticCorrectionUsageEvent!,
        shopifyReportState: ShopifyReportState.NEEDS_ATTENTION,
      },
    });

    await expect(test.service.reconcile(refund)).resolves.toBe("needs-attention");
    expect(test.providerState.read).not.toHaveBeenCalled();
    expect(test.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        reason: "automatic-correction-provider-needs-attention",
      }),
    }));
  });

  it.each([
    ShopifyReportState.PENDING,
    ShopifyReportState.IN_FLIGHT,
    ShopifyReportState.RETRYABLE,
  ])("keeps %s correction reports REQUESTED without provider reconciliation", async (state) => {
    const test = harness();
    const refund = linkedRefund({
      automaticCorrectionUsageEvent: {
        ...linkedRefund().automaticCorrectionUsageEvent!,
        shopifyReportState: state,
      },
    });

    await expect(test.service.reconcile(refund)).resolves.toBe("reconciled");
    expect(test.providerState.read).not.toHaveBeenCalled();
    expect(test.updateMany).not.toHaveBeenCalled();
  });

  it("moves unsafe provider proof to NEEDS_ATTENTION with a bounded reason", async () => {
    const test = harness();
    const reason = "x".repeat(1200);
    test.providerState.read.mockResolvedValue({ safe: false, reason });

    await expect(test.service.reconcile(linkedRefund())).resolves.toBe("needs-attention");
    expect(test.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        status: RecoveryCreditRefundStatus.NEEDS_ATTENTION,
        reason: reason.slice(0, 1000),
      },
    }));
  });

  it("treats the exact frozen BEFORE provider state as not caught up yet", async () => {
    const test = harness();

    await expect(test.service.reconcile(linkedRefund())).resolves.toBe("reconciled");
    expect(test.completion.complete).not.toHaveBeenCalled();
    expect(test.updateMany).not.toHaveBeenCalled();
  });

  it("delegates the exact frozen AFTER provider state to financial completion", async () => {
    const test = harness();
    test.providerState.read.mockResolvedValue({
      safe: true,
      quantity: new Prisma.Decimal("0"),
      cost: new Prisma.Decimal("0.00"),
      currency: "USD",
    });
    const refund = linkedRefund();

    await expect(test.service.reconcile(refund)).resolves.toBe("completed");
    expect(test.completion.complete).toHaveBeenCalledWith(refund, "USD");
    expect(test.updateMany).not.toHaveBeenCalled();
  });

  it("keeps the refund REQUESTED when the completion transaction cannot yet win", async () => {
    const test = harness();
    test.providerState.read.mockResolvedValue({
      safe: true,
      quantity: new Prisma.Decimal("0"),
      cost: new Prisma.Decimal("0.00"),
      currency: "USD",
    });
    test.completion.complete.mockResolvedValue(false);

    await expect(test.service.reconcile(linkedRefund())).resolves.toBe("reconciled");
    expect(test.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["quantity", "0.5", "0.50", "USD"],
    ["cost", "0", "0.50", "USD"],
    ["currency", "0", "0.00", "EUR"],
  ])("marks a third provider %s state as a conflict", async (_kind, quantity, cost, currency) => {
    const test = harness();
    test.providerState.read.mockResolvedValue({
      safe: true,
      quantity: new Prisma.Decimal(quantity),
      cost: new Prisma.Decimal(cost),
      currency,
    });

    await expect(test.service.reconcile(linkedRefund())).resolves.toBe("needs-attention");
    expect(test.completion.complete).not.toHaveBeenCalled();
    expect(test.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        status: RecoveryCreditRefundStatus.NEEDS_ATTENTION,
        reason: "automatic-correction-provider-state-conflict",
      },
    }));
  });
});
