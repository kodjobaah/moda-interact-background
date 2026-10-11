import {
  RecoveryCreditPurchaseStatus,
  RecoveryCreditRefundStatus,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import type { RefundRow } from "../../../../src/services/recovery-credit-refund-correction/refund-correction.types.js";
import { WooRefundHoldPreparationService } from "../../../../src/services/recovery-credit-refund-correction/woocommerce-refund-hold-preparation.service.js";

function refund(): RefundRow {
  return {
    id: "woo-refund-1",
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    shopId: "shop-1",
    provider: "WOOCOMMERCE",
    status: RecoveryCreditRefundStatus.REQUESTED,
    reason: null,
    purchaseId: "purchase-1",
    availableAmountAtRequestSnapshot: 4,
    billingPeriodIdSnapshot: "",
    providerSubscriptionIdSnapshot: "",
    planHandleSnapshot: "",
    eventHandleSnapshot: "",
    shopifyPartnerDevelopmentSnapshot: false,
    purchaseProviderAmountSnapshot: { isFinite: () => true } as never,
    purchaseProviderCurrencySnapshot: "USD",
    finalCreditQuantity: null,
    expectedProviderAmount: null,
    expectedProviderCurrency: null,
    automaticCorrectionUsageEventId: null,
    providerUsageQuantityBeforeCorrection: null,
    providerUsageCostBeforeCorrection: null,
    expectedProviderUsageQuantityAfterCorrection: null,
    expectedProviderUsageCostAfterCorrection: null,
    version: 0,
    purchase: {
      usageEventId: "purchase-event-1",
      status: RecoveryCreditPurchaseStatus.WITHDRAWN,
      currentAmount: 7,
      reservedAmount: 3,
      creditsGranted: 10,
    },
    shop: { shopifyShopId: null },
    automaticCorrectionUsageEvent: null,
  };
}

function harness(reservedAmount: number, currentAmount: number) {
  const updateRefund = vi.fn().mockResolvedValue({ count: 1 });
  const updatePurchase = vi.fn().mockResolvedValue({ count: 1 });
  const updateCounter = vi.fn().mockResolvedValue({ count: 1 });
  const transaction = {
    recoveryCreditRefund: {
      findUnique: vi.fn().mockResolvedValue({
        status: RecoveryCreditRefundStatus.REQUESTED,
        provider: "WOOCOMMERCE",
        version: 2,
        availableAmountAtRequestSnapshot: 4,
        finalCreditQuantity: null,
        automaticCorrectionUsageEventId: null,
        purchase: {
          status: RecoveryCreditPurchaseStatus.WITHDRAWN,
          currentAmount,
          reservedAmount,
          version: 3,
        },
      }),
      findMany: vi.fn().mockResolvedValue([{
        purchaseId: "purchase-1",
        purchase: {
          status: RecoveryCreditPurchaseStatus.WITHDRAWN,
          currentAmount,
          reservedAmount,
        },
      }]),
      updateMany: updateRefund,
    },
    recoveryCreditPurchase: { updateMany: updatePurchase },
    shopEntitlementCounter: {
      findUnique: vi.fn().mockImplementation(async () => ({
        id: "counter-1",
        version: 4,
        refundingQuantity: reservedAmount === 0 ? 7 : 4,
        grantedQuantity: 10,
      })),
      updateMany: updateCounter,
    },
  };
  const database = {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(transaction)),
  };
  return {
    service: new WooRefundHoldPreparationService(database as never),
    transaction,
    updateRefund,
    updatePurchase,
    updateCounter,
  };
}

describe("WooRefundHoldPreparationService", () => {
  it("waits while purchased-credit reservations remain", async () => {
    const test = harness(3, 7);

    await expect(test.service.prepare(refund())).resolves.toBe("waiting");
    expect(test.updateRefund).not.toHaveBeenCalled();
    expect(test.updateCounter).not.toHaveBeenCalled();
  });

  it("cancels a zero-credit request and releases its existing allowance hold", async () => {
    const test = harness(0, 0);

    await expect(test.service.prepare(refund())).resolves.toBe("cancelled");
    expect(test.updateRefund).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: RecoveryCreditRefundStatus.CANCELLED,
        reason: "NO_CREDITS_REMAINING",
      }),
    }));
    expect(test.updateCounter).toHaveBeenCalledWith(expect.objectContaining({
      data: { refundingQuantity: { decrement: 4 }, version: { increment: 1 } },
    }));
  });

  it("freezes the remaining credits and expands the hold after reservations release", async () => {
    const test = harness(0, 7);

    await expect(test.service.prepare(refund())).resolves.toBe("prepared");
    expect(test.updateRefund).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        finalCreditQuantity: 7,
        expectedProviderAmount: null,
        expectedProviderCurrency: null,
        status: RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED,
        reason: "WOO_VENDOR_DASHBOARD_REFUND_REQUIRED",
      }),
    }));
    expect(test.updateCounter).toHaveBeenCalledWith(expect.objectContaining({
      data: { version: { increment: 1 } },
    }));
    expect(test.updatePurchase).toHaveBeenCalledOnce();
  });

  it("does not count a reservation release twice when the reservation owner already expanded the hold", async () => {
    const test = harness(0, 7);

    await expect(test.service.prepare(refund())).resolves.toBe("prepared");
    expect(test.updateCounter).toHaveBeenCalledWith(expect.objectContaining({
      data: { version: { increment: 1 } },
    }));
    expect(test.updateCounter.mock.calls[0]?.[0].data).not.toHaveProperty("refundingQuantity");
  });
});