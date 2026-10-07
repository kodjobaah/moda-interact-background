import { Prisma } from "@prisma/client";
import { deriveShopifyProviderContextIdentity } from "@modainteract/moda-interact-shared/billing";
import { describe, expect, it, vi } from "vitest";

import { RefundProviderStateService } from "../../../../src/services/recovery-credit-refund-correction/refund-provider-state.service.js";

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
  providerUsageSnapshot: [
    {
      handle: "pack-meter",
      quantity: "1",
      costAmount: "1.00",
      costCurrency: "usd",
    },
  ],
  providerUsagePricingSnapshot: [
    {
      handle: "pack-meter",
      currency: "USD",
      tiersMode: "VOLUME",
      tiers: [{ upTo: null, amountPerUnit: "1.00", amount: "0.00" }],
    },
  ],
};

function refundInput(overrides: Record<string, unknown> = {}) {
  return {
    billingPeriodIdSnapshot: "period-1",
    providerSubscriptionIdSnapshot: deriveShopifyProviderContextIdentity({
      providerSubscriptionId: "sub-1",
      planHandle: "pro-2026",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    }),
    planHandleSnapshot: "pro-2026",
    eventHandleSnapshot: "pack-meter",
    shop: { shopifyShopId: "gid://shopify/Shop/1" },
    ...overrides,
  };
}

function harness(providerResult: typeof provider | null = provider) {
  const database = {
    billingPeriod: {
      findUnique: vi.fn().mockResolvedValue({ periodStart, periodEnd }),
    },
  };
  const partner = {
    getSubscriptionReconciliationSnapshot: vi.fn().mockResolvedValue({
      activeSubscription: providerResult,
      latestLifecycleEvent: null,
    }),
  };
  return {
    database,
    partner,
    service: new RefundProviderStateService(database as never, partner as never),
  };
}

describe("RefundProviderStateService", () => {
  it("reads frozen provider state without requiring live pricing", async () => {
    const test = harness({ ...provider, providerUsagePricingSnapshot: [] });

    await expect(test.service.read(refundInput())).resolves.toEqual({
      safe: true,
      quantity: new Prisma.Decimal("1"),
      cost: new Prisma.Decimal("1.00"),
      currency: "USD",
    });
  });

  it("requires live pricing only for PREPARE", async () => {
    const test = harness({ ...provider, providerUsagePricingSnapshot: [] });

    await expect(test.service.readForPrepare(refundInput())).resolves.toEqual({
      safe: false,
      reason: "Shopify provider pricing is unavailable or ambiguous",
    });
  });

  it("requires PREPARE pricing currency to match provider usage currency", async () => {
    const test = harness({
      ...provider,
      providerUsagePricingSnapshot: [
        { ...provider.providerUsagePricingSnapshot[0]!, currency: "EUR" },
      ],
    });

    await expect(test.service.readForPrepare(refundInput())).resolves.toEqual({
      safe: false,
      reason: "Shopify provider pricing is unavailable or ambiguous",
    });
  });

  it("rejects provider observations that do not match frozen refund provenance", async () => {
    const test = harness({ ...provider, planHandle: "different-plan" });

    await expect(test.service.read(refundInput())).resolves.toEqual({
      safe: false,
      reason: "Shopify provider context does not match frozen refund provenance",
    });
  });

  it("rejects provider periods that do not match the frozen billing period", async () => {
    const test = harness();
    test.database.billingPeriod.findUnique.mockResolvedValue({
      periodStart,
      periodEnd: new Date("2026-11-01T00:00:00.000Z"),
    });

    await expect(test.service.read(refundInput())).resolves.toEqual({
      safe: false,
      reason: "Shopify provider context does not match frozen refund provenance",
    });
  });

  it("rejects missing or invalid provider usage values", async () => {
    const test = harness({
      ...provider,
      providerUsageSnapshot: [
        {
          handle: "pack-meter",
          quantity: "not-a-number",
          costAmount: "1.00",
          costCurrency: "USD",
        },
      ],
    });

    await expect(test.service.read(refundInput())).resolves.toEqual({
      safe: false,
      reason: "Shopify provider quantity, cost, or currency is unavailable",
    });
  });

  it("fails before provider lookup when the shop has no Shopify identifier", async () => {
    const test = harness();

    await expect(test.service.read(refundInput({ shop: { shopifyShopId: null } }))).resolves.toEqual({
      safe: false,
      reason: "shop has no Shopify identifier",
    });
    expect(test.partner.getSubscriptionReconciliationSnapshot).not.toHaveBeenCalled();
  });

  it("rejects a missing active Shopify subscription", async () => {
    const test = harness(null);

    await expect(test.service.read(refundInput())).resolves.toEqual({
      safe: false,
      reason: "Shopify subscription is unavailable",
    });
  });
});
