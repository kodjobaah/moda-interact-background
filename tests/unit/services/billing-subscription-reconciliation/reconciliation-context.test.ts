import { describe, expect, it, vi } from "vitest";
import { ReconciliationContextService } from "../../../../src/services/billing-subscription-reconciliation/reconciliation-context.js";

describe("ReconciliationContextService", () => {
  it("loads only the bounded shop and subscription reconciliation fields by shop id", async () => {
    const shopRow = { id: "shop-1", subscription: { id: "subscription-1" } };
    const shopFindUnique = vi.fn().mockResolvedValue(shopRow);
    const service = new ReconciliationContextService({
      shop: { findUnique: shopFindUnique },
      billingPlan: { findUnique: vi.fn() },
    } as never);

    await expect(service.loadShop("shop-1")).resolves.toBe(shopRow);
    expect(shopFindUnique).toHaveBeenCalledExactlyOnceWith({
      where: { id: "shop-1" },
      select: {
        id: true,
        status: true,
        reinstallPendingAt: true,
        shopifyShopId: true,
        onboardingCompleted: true,
        subscription: {
          select: {
            id: true,
            status: true,
            planId: true,
            pendingPlanId: true,
            pendingShopifyPlanHandle: true,
            pendingEffectiveAt: true,
            nextReconcileAt: true,
            billingPeriodId: true,
            currentPeriodStart: true,
            currentPeriodEnd: true,
            cancelAtPeriodEnd: true,
            lastSyncErrorCode: true,
          },
        },
      },
    });
  });

  it("loads a current plan by id with only the fields required by billing handlers", async () => {
    const plan = { id: "plan-1", active: true, kind: "FREE" };
    const planFindUnique = vi.fn().mockResolvedValue(plan);
    const service = new ReconciliationContextService({
      shop: { findUnique: vi.fn() },
      billingPlan: { findUnique: planFindUnique },
    } as never);

    await expect(service.loadCurrentPlan("plan-1")).resolves.toBe(plan);
    expect(planFindUnique).toHaveBeenCalledExactlyOnceWith({
      where: { id: "plan-1" },
      select: {
        id: true,
        active: true,
        name: true,
        kind: true,
        shopifyPlanHandle: true,
        recoveryCreditPackEnabled: true,
        shopifyUsageEventHandle: true,
        shopifyRecoveryCreditPackEventHandle: true,
        includedRecoveryConversationAllowance: true,
      },
    });
  });
});