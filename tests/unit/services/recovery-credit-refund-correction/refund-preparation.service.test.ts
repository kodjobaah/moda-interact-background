import {
  Prisma,
  RecoveryCreditPurchaseStatus,
  RecoveryCreditRefundStatus,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  preparationHarness,
  providerProof,
  refundRow,
} from "./refund-preparation.test-support.js";

describe("RefundPreparationService", () => {
  it("creates an exact negative correction and freezes provider evidence atomically", async () => {
    const test = preparationHarness();

    await expect(test.service.prepare(test.row)).resolves.toEqual({ kind: "prepared" });
    expect(test.database.usageEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        quantity: new Prisma.Decimal("-1"),
        correctionOfUsageEventId: "purchase-event-1",
        sourceType: "RECOVERY_CREDIT_REFUND",
        sourceId: "refund-1",
        shopifyEventHandle: "pack-meter",
      }),
    }));
    expect(test.database.recoveryCreditRefund.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          finalCreditQuantity: 1,
          expectedProviderAmount: new Prisma.Decimal("1.00"),
          expectedProviderCurrency: "USD",
          providerUsageQuantityBeforeCorrection: new Prisma.Decimal("1"),
          providerUsageCostBeforeCorrection: new Prisma.Decimal("1.00"),
          expectedProviderUsageQuantityAfterCorrection: new Prisma.Decimal("0"),
          expectedProviderUsageCostAfterCorrection: new Prisma.Decimal("0.00"),
          automaticCorrectionUsageEventId: "correction-event-1",
        }),
      }),
    );
  });

  it("allows a zero-value correction only for a frozen partner-development purchase", async () => {
    const row = refundRow({
      shopifyPartnerDevelopmentSnapshot: true,
      purchaseProviderAmountSnapshot: new Prisma.Decimal("0.00"),
    });
    const test = preparationHarness(
      row,
      providerProof({
        cost: new Prisma.Decimal("0.00"),
        pricing: {
          handle: "pack-meter",
          currency: "USD",
          tiersMode: "VOLUME",
          tiers: [{ upTo: null, amountPerUnit: "0.00", amount: "0.00" }],
        },
      }),
    );

    await expect(test.service.prepare(row)).resolves.toEqual({ kind: "prepared" });
    expect(test.database.recoveryCreditRefund.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ expectedProviderAmount: new Prisma.Decimal("0.00") }),
      }),
    );
  });

  it("routes a zero-value production purchase to provider action before creating an event", async () => {
    const row = refundRow({ purchaseProviderAmountSnapshot: new Prisma.Decimal("0.00") });
    const test = preparationHarness(row);

    await expect(test.service.prepare(row)).resolves.toEqual({ kind: "provider-action-required" });
    expect(test.database.usageEvent.upsert).not.toHaveBeenCalled();
    expect(test.providerState.readForPrepare).not.toHaveBeenCalled();
    expect(test.database.recoveryCreditRefund.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED,
          finalCreditQuantity: null,
          expectedProviderAmount: null,
        }),
      }),
    );
  });

  it("freezes proportional fallback evidence when live provider proof is unavailable", async () => {
    const row = refundRow({
      purchaseProviderAmountSnapshot: new Prisma.Decimal("20.00"),
      purchase: {
        usageEventId: "purchase-event-1",
        status: RecoveryCreditPurchaseStatus.WITHDRAWN,
        currentAmount: 1,
        reservedAmount: 0,
        creditsGranted: 4,
      },
    });
    const test = preparationHarness(row, {
      safe: false,
      reason: "Shopify provider pricing is unavailable or ambiguous",
    });

    await expect(test.service.prepare(row)).resolves.toEqual({ kind: "provider-action-required" });
    expect(test.database.usageEvent.upsert).not.toHaveBeenCalled();
    expect(test.database.recoveryCreditRefund.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          finalCreditQuantity: 1,
          expectedProviderAmount: new Prisma.Decimal("5.00"),
          expectedProviderCurrency: "USD",
          status: RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED,
        }),
      }),
    );
  });

  it("prepares an exact proportional correction when live pricing proves the refund amount", async () => {
    const row = refundRow({
      purchaseProviderAmountSnapshot: new Prisma.Decimal("1.00"),
      purchase: {
        usageEventId: "purchase-event-1",
        status: RecoveryCreditPurchaseStatus.WITHDRAWN,
        currentAmount: 1,
        reservedAmount: 0,
        creditsGranted: 4,
      },
    });
    const test = preparationHarness(
      row,
      providerProof({
        quantity: new Prisma.Decimal("4.00"),
        cost: new Prisma.Decimal("4.00"),
      }),
    );

    await expect(test.service.prepare(row)).resolves.toEqual({ kind: "prepared" });
    expect(test.database.usageEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ quantity: new Prisma.Decimal("-0.25") }),
    }));
    expect(test.database.recoveryCreditRefund.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          expectedProviderAmount: new Prisma.Decimal("0.25"),
          providerUsageQuantityBeforeCorrection: new Prisma.Decimal("4.00"),
          expectedProviderUsageQuantityAfterCorrection: new Prisma.Decimal("3.75"),
          expectedProviderUsageCostAfterCorrection: new Prisma.Decimal("3.75"),
        }),
      }),
    );
  });

  it("rolls back a staged correction when the refund-link CAS is lost", async () => {
    const test = preparationHarness();
    let staged = false;
    let persisted = false;
    test.database.usageEvent.upsert.mockImplementation(async () => {
      staged = true;
      return { id: "correction-event-1" };
    });
    test.database.recoveryCreditRefund.updateMany.mockResolvedValueOnce({ count: 0 });
    test.database.$transaction.mockImplementation(
      async (callback: (transaction: unknown) => Promise<unknown>) => {
        try {
          await callback(test.database);
          persisted = staged;
        } catch (error) {
          staged = false;
          throw error;
        }
      },
    );

    await expect(test.service.prepare(test.row)).resolves.toEqual({
      kind: "reconcile",
      refund: null,
    });
    expect(staged).toBe(false);
    expect(persisted).toBe(false);
  });

  it("reloads the winning linked refund after losing the preparation CAS", async () => {
    const test = preparationHarness();
    const linked = refundRow({ automaticCorrectionUsageEventId: "winner-event" });
    test.database.recoveryCreditRefund.updateMany.mockResolvedValueOnce({ count: 0 });
    test.database.recoveryCreditRefund.findUnique.mockResolvedValue(linked);

    await expect(test.service.prepare(test.row)).resolves.toEqual({
      kind: "reconcile",
      refund: linked,
    });
    expect(test.database.recoveryCreditRefund.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "refund-1" } }),
    );
  });

  it("does not create a correction when live pricing cannot prove the refund amount", async () => {
    const row = refundRow({ purchaseProviderAmountSnapshot: new Prisma.Decimal("2.00") });
    const test = preparationHarness(row);

    await expect(test.service.prepare(row)).resolves.toEqual({ kind: "provider-action-required" });
    expect(test.database.usageEvent.upsert).not.toHaveBeenCalled();
    expect(test.database.recoveryCreditRefund.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED,
          reason: "live Shopify pricing does not prove the refund amount",
        }),
      }),
    );
  });
});
