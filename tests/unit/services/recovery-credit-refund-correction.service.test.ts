import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { deriveShopifyProviderContextIdentity } from "@modainteract/moda-interact-shared/billing";

import { RecoveryCreditRefundCorrectionService } from "../../../src/services/recovery-credit-refund-correction.service.js";

const periodStart = new Date("2026-09-01T00:00:00.000Z");
const periodEnd = new Date("2026-10-01T00:00:00.000Z");
const provider = {
  planHandle: "pro-2026",
  usageEventHandles: ["pack-meter"],
  pendingPlanHandle: null,
  pendingEffectiveAt: null,
  status: "ACTIVE" as const,
  currentPeriodStart: periodStart,
  currentPeriodEnd: periodEnd,
  trialEndsAt: null,
  cancelAtPeriodEnd: false,
  providerSubscriptionId: "sub-1",
  providerUsageSnapshot: [{ handle: "pack-meter", quantity: "1", costAmount: "1.00", costCurrency: "USD" }],
  providerUsagePricingSnapshot: [{ handle: "pack-meter", currency: "USD", tiersMode: "VOLUME", tiers: [{ upTo: null, amountPerUnit: "1.00", amount: "0.00" }] }],
};

function refundRow(overrides: Record<string, unknown> = {}) {
  const context = deriveShopifyProviderContextIdentity({ providerSubscriptionId: "sub-1", planHandle: "pro-2026", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd });
  return {
    id: "refund-1",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    shopId: "shop-1",
    status: "REQUESTED",
    reason: null,
    purchaseId: "purchase-1",
    billingPeriodIdSnapshot: "period-1",
    providerSubscriptionIdSnapshot: context,
    planHandleSnapshot: "pro-2026",
    eventHandleSnapshot: "pack-meter",
    shopifyPartnerDevelopmentSnapshot: false,
    purchaseProviderAmountSnapshot: new Prisma.Decimal("1.00"),
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
    purchase: { usageEventId: "purchase-event-1", status: "WITHDRAWN", currentAmount: 1, reservedAmount: 0, creditsGranted: 1 },
    shop: { shopifyShopId: "gid://shopify/Shop/1" },
    automaticCorrectionUsageEvent: null,
    ...overrides,
  };
}

function harness(row = refundRow(), providerResult = provider) {
  const refundUpdate = vi.fn().mockResolvedValue({ count: 1 });
  const usageUpsert = vi.fn().mockResolvedValue({ id: "correction-event-1" });
  const database = {
    recoveryCreditRefund: { findMany: vi.fn().mockResolvedValue([row]), findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn(), updateMany: refundUpdate },
    billingPeriod: { findUnique: vi.fn().mockResolvedValue({ periodStart, periodEnd }) },
    usageEvent: { upsert: usageUpsert },
    recoveryCreditPurchase: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn(), updateMany: vi.fn() },
    shopEntitlementCounter: { findUnique: vi.fn(), updateMany: vi.fn() },
    merchantSupportThread: { upsert: vi.fn().mockResolvedValue({ id: "thread-1" }), update: vi.fn() },
    merchantSupportMessage: { upsert: vi.fn() },
    $transaction: vi.fn().mockImplementation(async (callback: (transaction: unknown) => unknown) => callback(database)),
  };
  const partner = { getSubscriptionReconciliationSnapshot: vi.fn().mockResolvedValue({ activeSubscription: providerResult, latestLifecycleEvent: null }) };
  return { database, partner, service: new RecoveryCreditRefundCorrectionService(database as never, partner as never) };
}

describe("RecoveryCreditRefundCorrectionService", () => {
  it("prepares an exact full-pack negative correction and freezes typed evidence atomically", async () => {
    const test = harness();

    await expect(test.service.processDue()).resolves.toMatchObject({ selected: 1, prepared: 1 });
    expect(test.database.usageEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ quantity: new Prisma.Decimal("-1"), correctionOfUsageEventId: "purchase-event-1", sourceType: "RECOVERY_CREDIT_REFUND", sourceId: "refund-1" }),
    }));
    expect(test.database.recoveryCreditRefund.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ finalCreditQuantity: 1, expectedProviderAmount: new Prisma.Decimal("1.00"), expectedProviderCurrency: "USD", providerUsageQuantityBeforeCorrection: new Prisma.Decimal("1"), expectedProviderUsageQuantityAfterCorrection: new Prisma.Decimal("0") }),
    }));
  });

  it("prepares a zero-value negative correction only for a verified partner-development refund snapshot", async () => {
    const zeroProvider = {
      ...provider,
      providerUsageSnapshot: [
        {
          handle: "pack-meter",
          quantity: "1",
          costAmount: "0.00",
          costCurrency: "USD",
        },
      ],
      providerUsagePricingSnapshot: [
        {
          handle: "pack-meter",
          currency: "USD",
          tiersMode: "VOLUME",
          tiers: [{ upTo: null, amountPerUnit: "0.00", amount: "0.00" }],
        },
      ],
    };
    const test = harness(
      refundRow({
        shopifyPartnerDevelopmentSnapshot: true,
        purchaseProviderAmountSnapshot: new Prisma.Decimal("0.00"),
      }),
      zeroProvider,
    );

    await expect(test.service.processDue()).resolves.toMatchObject({
      selected: 1,
      prepared: 1,
      providerActionRequired: 0,
    });
    expect(test.database.usageEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          quantity: new Prisma.Decimal("-1"),
        }),
      }),
    );
    expect(test.database.recoveryCreditRefund.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          expectedProviderAmount: new Prisma.Decimal("0.00"),
          providerUsageCostBeforeCorrection: new Prisma.Decimal("0.00"),
          expectedProviderUsageCostAfterCorrection: new Prisma.Decimal("0.00"),
        }),
      }),
    );
  });

  it("does not prepare a zero-value production refund even if one reaches Background", async () => {
    const zeroProvider = {
      ...provider,
      providerUsageSnapshot: [
        {
          handle: "pack-meter",
          quantity: "1",
          costAmount: "0.00",
          costCurrency: "USD",
        },
      ],
      providerUsagePricingSnapshot: [
        {
          handle: "pack-meter",
          currency: "USD",
          tiersMode: "VOLUME",
          tiers: [{ upTo: null, amountPerUnit: "0.00", amount: "0.00" }],
        },
      ],
    };
    const test = harness(
      refundRow({
        shopifyPartnerDevelopmentSnapshot: false,
        purchaseProviderAmountSnapshot: new Prisma.Decimal("0.00"),
      }),
      zeroProvider,
    );

    await expect(test.service.processDue()).resolves.toMatchObject({
      selected: 1,
      prepared: 0,
      providerActionRequired: 1,
    });
    expect(test.database.usageEvent.upsert).not.toHaveBeenCalled();
  });

  it("routes ambiguous live pricing to provider action before creating an event", async () => {
    const test = harness(refundRow(), { ...provider, providerUsagePricingSnapshot: [] });

    await expect(test.service.processDue()).resolves.toMatchObject({ selected: 1, providerActionRequired: 1 });
    expect(test.database.usageEvent.upsert).not.toHaveBeenCalled();
    expect(test.database.recoveryCreditRefund.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PROVIDER_ACTION_REQUIRED" }) }));
  });

  it("completes exact reported provider proof and decrements both counters once", async () => {
    const row = refundRow({
      automaticCorrectionUsageEventId: "correction-event-1",
      finalCreditQuantity: 1,
      expectedProviderAmount: new Prisma.Decimal("1.00"),
      expectedProviderCurrency: "USD",
      providerUsageQuantityBeforeCorrection: new Prisma.Decimal("1"),
      providerUsageCostBeforeCorrection: new Prisma.Decimal("1.00"),
      expectedProviderUsageQuantityAfterCorrection: new Prisma.Decimal("0"),
      expectedProviderUsageCostAfterCorrection: new Prisma.Decimal("0.00"),
      automaticCorrectionUsageEvent: {
        id: "correction-event-1", quantity: new Prisma.Decimal("-1"), correctionOfUsageEventId: "purchase-event-1", sourceType: "RECOVERY_CREDIT_REFUND", sourceId: "refund-1", shopifyEventHandle: "pack-meter", shopifyIdempotencyKey: "shopify-key", shopifyReportState: "REPORTED",
      },
    });
    const test = harness(row, {
      ...provider,
      providerUsageSnapshot: [{ handle: "pack-meter", quantity: "0", costAmount: "0.00", costCurrency: "USD" }],
      providerUsagePricingSnapshot: [],
    });
    test.database.recoveryCreditPurchase.findUnique.mockResolvedValue({ status: "WITHDRAWN", currentAmount: 1, reservedAmount: 0, version: 3 });
    test.database.shopEntitlementCounter.findUnique.mockResolvedValue({ id: "counter-1", version: 4, refundingQuantity: 1, grantedQuantity: 1 });
    test.database.recoveryCreditPurchase.updateMany.mockResolvedValue({ count: 1 });
    test.database.shopEntitlementCounter.updateMany.mockResolvedValue({ count: 1 });

    await expect(test.service.processDue()).resolves.toMatchObject({ selected: 1, completed: 1 });
    expect(test.database.shopEntitlementCounter.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ refundingQuantity: { decrement: 1 }, grantedQuantity: { decrement: 1 } }) }));
    expect(test.database.recoveryCreditRefund.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ version: 0, automaticCorrectionUsageEventId: "correction-event-1" }), data: expect.objectContaining({ status: "COMPLETED", providerConfirmedByPlatformAdminId: null, providerActionKind: null }) }));
    expect(test.database.merchantSupportMessage.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ systemCode: "BILLING_REFUND_COMPLETED", sourceLanguageTag: "en-GB", kind: "SYSTEM", state: "AVAILABLE" }) }));
    expect(test.database.merchantSupportMessage.upsert).toHaveBeenCalledTimes(1);
  });

  it("keeps native App Pricing eligible when the legacy provider id is null", async () => {
    const nativeProvider = { ...provider, providerSubscriptionId: null };
    const context = deriveShopifyProviderContextIdentity({ providerSubscriptionId: null, planHandle: "pro-2026", currentPeriodStart: periodStart, currentPeriodEnd: periodEnd });
    const test = harness(refundRow({ providerSubscriptionIdSnapshot: context }), nativeProvider);

    await expect(test.service.processDue()).resolves.toMatchObject({ prepared: 1, providerActionRequired: 0 });
    expect(test.database.usageEvent.upsert).toHaveBeenCalledTimes(1);
  });

  it("reconciles frozen evidence without requiring live pricing", async () => {
    const row = refundRow({
      automaticCorrectionUsageEventId: "correction-event-1",
      finalCreditQuantity: 1,
      expectedProviderAmount: new Prisma.Decimal("1.00"),
      expectedProviderCurrency: "USD",
      providerUsageQuantityBeforeCorrection: new Prisma.Decimal("1"),
      providerUsageCostBeforeCorrection: new Prisma.Decimal("1.00"),
      expectedProviderUsageQuantityAfterCorrection: new Prisma.Decimal("0"),
      expectedProviderUsageCostAfterCorrection: new Prisma.Decimal("0.00"),
      automaticCorrectionUsageEvent: { id: "correction-event-1", quantity: new Prisma.Decimal("-1"), correctionOfUsageEventId: "purchase-event-1", sourceType: "RECOVERY_CREDIT_REFUND", sourceId: "refund-1", shopifyEventHandle: "pack-meter", shopifyIdempotencyKey: "shopify-key", shopifyReportState: "REPORTED" },
    });
    const test = harness(row, { ...provider, providerUsageSnapshot: [{ handle: "pack-meter", quantity: "0", costAmount: "0.00", costCurrency: "USD" }], providerUsagePricingSnapshot: [] });
    test.database.recoveryCreditPurchase.findUnique.mockResolvedValue({ status: "WITHDRAWN", currentAmount: 1, reservedAmount: 0, version: 3 });
    test.database.shopEntitlementCounter.findUnique.mockResolvedValue({ id: "counter-1", version: 4, refundingQuantity: 1, grantedQuantity: 1 });
    test.database.recoveryCreditPurchase.updateMany.mockResolvedValue({ count: 1 });
    test.database.shopEntitlementCounter.updateMany.mockResolvedValue({ count: 1 });

    await expect(test.service.processDue()).resolves.toMatchObject({ completed: 1 });
  });

  it("freezes a proportional amount for an unsafe partial-pack fallback", async () => {
    const test = harness(refundRow({ purchase: { usageEventId: "purchase-event-1", status: "WITHDRAWN", currentAmount: 1, reservedAmount: 0, creditsGranted: 4 }, purchaseProviderAmountSnapshot: new Prisma.Decimal("20.00") }), { ...provider, providerUsagePricingSnapshot: [] });

    await expect(test.service.processDue()).resolves.toMatchObject({ providerActionRequired: 1 });
    expect(test.database.recoveryCreditRefund.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ finalCreditQuantity: 1, expectedProviderAmount: new Prisma.Decimal("5.00"), expectedProviderCurrency: "USD", status: "PROVIDER_ACTION_REQUIRED" }) }));
    expect(test.database.usageEvent.upsert).not.toHaveBeenCalled();
  });

  it("leaves a reported correction requested when the provider has not caught up", async () => {
    const row = refundRow({
      automaticCorrectionUsageEventId: "correction-event-1",
      finalCreditQuantity: 1,
      expectedProviderAmount: new Prisma.Decimal("1.00"),
      expectedProviderCurrency: "USD",
      providerUsageQuantityBeforeCorrection: new Prisma.Decimal("1"),
      providerUsageCostBeforeCorrection: new Prisma.Decimal("1.00"),
      expectedProviderUsageQuantityAfterCorrection: new Prisma.Decimal("0"),
      expectedProviderUsageCostAfterCorrection: new Prisma.Decimal("0.00"),
      automaticCorrectionUsageEvent: { id: "correction-event-1", quantity: new Prisma.Decimal("-1"), correctionOfUsageEventId: "purchase-event-1", sourceType: "RECOVERY_CREDIT_REFUND", sourceId: "refund-1", shopifyEventHandle: "pack-meter", shopifyIdempotencyKey: "shopify-key", shopifyReportState: "REPORTED" },
    });
    const test = harness(row);

    await expect(test.service.processDue()).resolves.toMatchObject({ selected: 1, reconciled: 1, completed: 0 });
    expect(test.database.recoveryCreditRefund.updateMany).not.toHaveBeenCalled();
  });

  it("moves a linked provider-needs-attention event to refund NEEDS_ATTENTION", async () => {
    const row = refundRow({
      automaticCorrectionUsageEventId: "correction-event-1",
      finalCreditQuantity: 1,
      expectedProviderAmount: new Prisma.Decimal("1.00"),
      expectedProviderCurrency: "USD",
      providerUsageQuantityBeforeCorrection: new Prisma.Decimal("1"),
      providerUsageCostBeforeCorrection: new Prisma.Decimal("1.00"),
      expectedProviderUsageQuantityAfterCorrection: new Prisma.Decimal("0"),
      expectedProviderUsageCostAfterCorrection: new Prisma.Decimal("0.00"),
      automaticCorrectionUsageEvent: { id: "correction-event-1", quantity: new Prisma.Decimal("-1"), correctionOfUsageEventId: "purchase-event-1", sourceType: "RECOVERY_CREDIT_REFUND", sourceId: "refund-1", shopifyEventHandle: "pack-meter", shopifyIdempotencyKey: "shopify-key", shopifyReportState: "NEEDS_ATTENTION" },
    });
    const test = harness(row);

    await expect(test.service.processDue()).resolves.toMatchObject({ selected: 1, needsAttention: 1 });
    expect(test.database.recoveryCreditRefund.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "NEEDS_ATTENTION" }) }));
  });

  it("reloads and reconciles when a concurrent prepare loses the refund-link CAS", async () => {
    const initial = refundRow();
    const linked = refundRow({
      automaticCorrectionUsageEventId: "correction-event-1",
      finalCreditQuantity: 1,
      expectedProviderAmount: new Prisma.Decimal("1.00"),
      expectedProviderCurrency: "USD",
      providerUsageQuantityBeforeCorrection: new Prisma.Decimal("1"),
      providerUsageCostBeforeCorrection: new Prisma.Decimal("1.00"),
      expectedProviderUsageQuantityAfterCorrection: new Prisma.Decimal("0"),
      expectedProviderUsageCostAfterCorrection: new Prisma.Decimal("0.00"),
      automaticCorrectionUsageEvent: { id: "correction-event-1", quantity: new Prisma.Decimal("-1"), correctionOfUsageEventId: "purchase-event-1", sourceType: "RECOVERY_CREDIT_REFUND", sourceId: "refund-1", shopifyEventHandle: "pack-meter", shopifyIdempotencyKey: "shopify-key", shopifyReportState: "PENDING" },
    });
    const test = harness(initial);
    test.database.recoveryCreditRefund.updateMany.mockResolvedValueOnce({ count: 0 });
    test.database.recoveryCreditRefund.findUnique.mockResolvedValue(linked);

    await expect(test.service.processDue()).resolves.toMatchObject({ selected: 1, reconciled: 1, prepared: 0 });
    expect(test.database.usageEvent.upsert).toHaveBeenCalledTimes(1);
    expect(test.database.recoveryCreditRefund.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "refund-1" } }));
  });

  it("does not transition a safe prepare race into a publishable fallback event", async () => {
    const test = harness(refundRow());
    test.database.recoveryCreditRefund.updateMany.mockResolvedValueOnce({ count: 0 });
    test.database.recoveryCreditRefund.findUnique.mockResolvedValue(refundRow({ status: "PROVIDER_ACTION_REQUIRED" }));

    await expect(test.service.processDue()).resolves.toMatchObject({ selected: 1, prepared: 0, reconciled: 1, providerActionRequired: 0 });
    expect(test.database.recoveryCreditRefund.updateMany).toHaveBeenCalledTimes(1);
  });

  it("prepares only the oldest requested refund for a meter in one scheduler pass", async () => {
    const oldest = refundRow({ id: "refund-oldest", createdAt: new Date("2026-09-01T00:00:00.000Z") });
    const newest = refundRow({ id: "refund-newest", createdAt: new Date("2026-09-02T00:00:00.000Z") });
    const test = harness(oldest);
    test.database.recoveryCreditRefund.findMany.mockResolvedValue([oldest, newest]);

    await expect(test.service.processDue()).resolves.toMatchObject({ selected: 2, prepared: 1 });
    expect(test.database.usageEvent.upsert).toHaveBeenCalledTimes(1);
  });

  it("allows different handles for the same shop to prepare independently", async () => {
    const first = refundRow({ id: "refund-first" });
    const second = refundRow({ id: "refund-second", eventHandleSnapshot: "other-meter" });
    const test = harness(first, {
      ...provider,
      usageEventHandles: ["pack-meter", "other-meter"],
      providerUsageSnapshot: [
        { handle: "pack-meter", quantity: "1", costAmount: "1.00", costCurrency: "USD" },
        { handle: "other-meter", quantity: "1", costAmount: "1.00", costCurrency: "USD" },
      ],
      providerUsagePricingSnapshot: [
        { handle: "pack-meter", currency: "USD", tiersMode: "VOLUME", tiers: [{ upTo: null, amountPerUnit: "1.00", amount: "0.00" }] },
        { handle: "other-meter", currency: "USD", tiersMode: "VOLUME", tiers: [{ upTo: null, amountPerUnit: "1.00", amount: "0.00" }] },
      ],
    });
    test.database.recoveryCreditRefund.findMany.mockResolvedValue([first, second]);

    await expect(test.service.processDue()).resolves.toMatchObject({ selected: 2, prepared: 2 });
    expect(test.database.usageEvent.upsert).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["PROVIDER_ACTION_REQUIRED", "an earlier provider-action refund"],
    ["NEEDS_ATTENTION", "an earlier needs-attention refund"],
  ])("defers behind %s on the same meter", async (status) => {
    const test = harness(refundRow());
    test.database.recoveryCreditRefund.findFirst.mockResolvedValue({ id: "older-refund" });

    await expect(test.service.processDue()).resolves.toMatchObject({ reconciled: 1, prepared: 0 });
    expect(test.database.usageEvent.upsert).not.toHaveBeenCalled();
  });

  it("defers while an unresolved purchase exists on the same meter", async () => {
    const test = harness(refundRow());
    test.database.recoveryCreditPurchase.findFirst.mockResolvedValue({ id: "purchase-1" });

    await expect(test.service.processDue()).resolves.toMatchObject({ reconciled: 1, prepared: 0 });
    expect(test.database.usageEvent.upsert).not.toHaveBeenCalled();
  });

  it("allows an unresolved purchase on a different handle", async () => {
    const first = refundRow({ id: "refund-first" });
    const second = refundRow({ id: "refund-second", eventHandleSnapshot: "other-meter" });
    const test = harness(first, {
      ...provider,
      usageEventHandles: ["pack-meter", "other-meter"],
      providerUsageSnapshot: [
        { handle: "pack-meter", quantity: "1", costAmount: "1.00", costCurrency: "USD" },
        { handle: "other-meter", quantity: "1", costAmount: "1.00", costCurrency: "USD" },
      ],
      providerUsagePricingSnapshot: [
        { handle: "pack-meter", currency: "USD", tiersMode: "VOLUME", tiers: [{ upTo: null, amountPerUnit: "1.00", amount: "0.00" }] },
        { handle: "other-meter", currency: "USD", tiersMode: "VOLUME", tiers: [{ upTo: null, amountPerUnit: "1.00", amount: "0.00" }] },
      ],
    });
    test.database.recoveryCreditRefund.findMany.mockResolvedValue([first, second]);
    test.database.recoveryCreditPurchase.findFirst.mockImplementation(async (args: { where: { shopifyEventHandleSnapshot: string } }) => (
      args.where.shopifyEventHandleSnapshot === "pack-meter" ? { id: "purchase-1" } : null
    ));

    await expect(test.service.processDue()).resolves.toMatchObject({ selected: 2, prepared: 1, reconciled: 1 });
    expect(test.database.usageEvent.upsert).toHaveBeenCalledTimes(1);
  });

  it("unblocks the next refund after an older refund becomes terminal and rereads the provider baseline", async () => {
    const refund = refundRow();
    const test = harness(refund, provider);
    test.database.recoveryCreditRefund.findFirst
      .mockResolvedValueOnce({ id: "older-refund" })
      .mockResolvedValueOnce(null);
    test.partner.getSubscriptionReconciliationSnapshot
      .mockResolvedValueOnce({ activeSubscription: provider, latestLifecycleEvent: null })
      .mockResolvedValueOnce({
        activeSubscription: {
          ...provider,
          providerUsageSnapshot: [{ handle: "pack-meter", quantity: "2", costAmount: "2.00", costCurrency: "USD" }],
        },
        latestLifecycleEvent: null,
      });

    await expect(test.service.processDue()).resolves.toMatchObject({ reconciled: 1, prepared: 0 });
    await expect(test.service.processDue()).resolves.toMatchObject({ prepared: 1, reconciled: 0 });
    expect(test.partner.getSubscriptionReconciliationSnapshot).toHaveBeenCalledTimes(1);
    expect(test.database.usageEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ quantity: new Prisma.Decimal("-1") }),
    }));
  });

  it("classifies exact before state as reconciled without changing the refund", async () => {
    const row = refundRow({
      automaticCorrectionUsageEventId: "correction-event-1",
      finalCreditQuantity: 1,
      expectedProviderAmount: new Prisma.Decimal("1.00"),
      expectedProviderCurrency: "USD",
      providerUsageQuantityBeforeCorrection: new Prisma.Decimal("1"),
      providerUsageCostBeforeCorrection: new Prisma.Decimal("1.00"),
      expectedProviderUsageQuantityAfterCorrection: new Prisma.Decimal("0"),
      expectedProviderUsageCostAfterCorrection: new Prisma.Decimal("0.00"),
      automaticCorrectionUsageEvent: { id: "correction-event-1", quantity: new Prisma.Decimal("-1"), correctionOfUsageEventId: "purchase-event-1", sourceType: "RECOVERY_CREDIT_REFUND", sourceId: "refund-1", shopifyEventHandle: "pack-meter", shopifyIdempotencyKey: "shopify-key", shopifyReportState: "REPORTED" },
    });
    const test = harness(row);

    await expect(test.service.processDue()).resolves.toMatchObject({ reconciled: 1, completed: 0 });
    expect(test.database.recoveryCreditRefund.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["quantity", { quantity: "0.5", costAmount: "0.50" }],
    ["cost", { quantity: "0", costAmount: "0.50" }],
    ["currency", { quantity: "0", costAmount: "0.00", costCurrency: "EUR" }],
  ])("marks a third provider %s value as a conflict", async (_kind, usage) => {
    const row = refundRow({
      automaticCorrectionUsageEventId: "correction-event-1",
      finalCreditQuantity: 1,
      expectedProviderAmount: new Prisma.Decimal("1.00"),
      expectedProviderCurrency: "USD",
      providerUsageQuantityBeforeCorrection: new Prisma.Decimal("1"),
      providerUsageCostBeforeCorrection: new Prisma.Decimal("1.00"),
      expectedProviderUsageQuantityAfterCorrection: new Prisma.Decimal("0"),
      expectedProviderUsageCostAfterCorrection: new Prisma.Decimal("0.00"),
      automaticCorrectionUsageEvent: { id: "correction-event-1", quantity: new Prisma.Decimal("-1"), correctionOfUsageEventId: "purchase-event-1", sourceType: "RECOVERY_CREDIT_REFUND", sourceId: "refund-1", shopifyEventHandle: "pack-meter", shopifyIdempotencyKey: "shopify-key", shopifyReportState: "REPORTED" },
    });
    const test = harness(row, { ...provider, providerUsageSnapshot: [{ handle: "pack-meter", costCurrency: "USD", ...usage }] });

    await expect(test.service.processDue()).resolves.toMatchObject({ needsAttention: 1 });
    expect(test.database.recoveryCreditRefund.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "NEEDS_ATTENTION", reason: "automatic-correction-provider-state-conflict" }) }));
  });

  it("classifies an unsafe fractional partial-pack provider state as a conflict", async () => {
    const row = refundRow({
      automaticCorrectionUsageEventId: "correction-event-1",
      finalCreditQuantity: 1,
      expectedProviderAmount: new Prisma.Decimal("0.25"),
      expectedProviderCurrency: "USD",
      providerUsageQuantityBeforeCorrection: new Prisma.Decimal("4.00"),
      providerUsageCostBeforeCorrection: new Prisma.Decimal("4.00"),
      expectedProviderUsageQuantityAfterCorrection: new Prisma.Decimal("3.75"),
      expectedProviderUsageCostAfterCorrection: new Prisma.Decimal("3.75"),
      automaticCorrectionUsageEvent: { id: "correction-event-1", quantity: new Prisma.Decimal("-0.25"), correctionOfUsageEventId: "purchase-event-1", sourceType: "RECOVERY_CREDIT_REFUND", sourceId: "refund-1", shopifyEventHandle: "pack-meter", shopifyIdempotencyKey: "shopify-key", shopifyReportState: "REPORTED" },
    });
    const test = harness(row, { ...provider, providerUsageSnapshot: [{ handle: "pack-meter", quantity: "3.50", costAmount: "3.50", costCurrency: "USD" }], providerUsagePricingSnapshot: [] });

    await expect(test.service.processDue()).resolves.toMatchObject({ needsAttention: 1, reconciled: 0 });
    expect(test.database.recoveryCreditRefund.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "NEEDS_ATTENTION", reason: "automatic-correction-provider-state-conflict" }) }));
  });

  it("rolls back the staged correction event when the refund-link CAS is lost", async () => {
    const test = harness(refundRow());
    let staged = false;
    let persisted = false;
    test.database.usageEvent.upsert.mockImplementation(async () => {
      staged = true;
      return { id: "correction-event-1" };
    });
    test.database.recoveryCreditRefund.updateMany.mockResolvedValueOnce({ count: 0 });
    test.database.recoveryCreditRefund.findUnique.mockResolvedValue(null);
    test.database.$transaction.mockImplementation(async (callback: (transaction: unknown) => Promise<unknown>) => {
      try {
        await callback(test.database);
        persisted = staged;
      } catch (error) {
        staged = false;
        throw error;
      }
    });

    await expect(test.service.processDue()).resolves.toMatchObject({ prepared: 0, reconciled: 1 });
    expect(staged).toBe(false);
    expect(persisted).toBe(false);
    expect(test.database.usageEvent.upsert).toHaveBeenCalledTimes(1);
  });

  it("keeps fractional PREPARE evidence immutable on linked reconciliation retry", async () => {
    const initial = refundRow({
      purchaseProviderAmountSnapshot: new Prisma.Decimal("1.00"),
      purchase: { usageEventId: "purchase-event-1", status: "WITHDRAWN", currentAmount: 1, reservedAmount: 0, creditsGranted: 4 },
    });
    const linked = refundRow({
      ...initial,
      automaticCorrectionUsageEventId: "correction-event-1",
      finalCreditQuantity: 1,
      expectedProviderAmount: new Prisma.Decimal("0.25"),
      expectedProviderCurrency: "USD",
      providerUsageQuantityBeforeCorrection: new Prisma.Decimal("4.00"),
      providerUsageCostBeforeCorrection: new Prisma.Decimal("4.00"),
      expectedProviderUsageQuantityAfterCorrection: new Prisma.Decimal("3.75"),
      expectedProviderUsageCostAfterCorrection: new Prisma.Decimal("3.75"),
      automaticCorrectionUsageEvent: { id: "correction-event-1", quantity: new Prisma.Decimal("-0.25"), correctionOfUsageEventId: "purchase-event-1", sourceType: "RECOVERY_CREDIT_REFUND", sourceId: "refund-1", shopifyEventHandle: "pack-meter", shopifyIdempotencyKey: "shopify-key", shopifyReportState: "PENDING" },
    });
    const test = harness(initial, {
      ...provider,
      providerUsageSnapshot: [{ handle: "pack-meter", quantity: "4.00", costAmount: "4.00", costCurrency: "USD" }],
    });
    test.database.recoveryCreditRefund.findMany.mockResolvedValueOnce([initial]).mockResolvedValueOnce([linked]);
    test.database.usageEvent.upsert.mockResolvedValue({ id: "correction-event-1" });

    await expect(test.service.processDue()).resolves.toMatchObject({ prepared: 1 });
    await expect(test.service.processDue()).resolves.toMatchObject({ reconciled: 1, prepared: 0 });
    expect(test.database.usageEvent.upsert).toHaveBeenCalledTimes(1);
    expect(test.database.recoveryCreditRefund.updateMany).toHaveBeenCalledTimes(1);
    expect(test.database.recoveryCreditRefund.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        providerUsageQuantityBeforeCorrection: new Prisma.Decimal("4.00"),
        expectedProviderUsageQuantityAfterCorrection: new Prisma.Decimal("3.75"),
      }),
    }));
  });
});