import { beforeEach, describe, expect, it, vi } from "vitest";
import { CheckoutEventOrchestratorService } from "../../../../src/services/checkout-recovery/checkout-event-orchestrator.service.js";

const activityAt = "2026-10-03T08:00:00.000Z";
const event = {
  shopDomain: "shop.myshopify.com",
  checkoutToken: "checkout-1",
  activityAt,
};
const activeRecovery = {
  id: "recovery-1",
  status: "ENGAGED",
  cartToken: "cart-1",
  currency: "CAD",
  totalPrice: "17.00",
  lineItems: [{ title: "Durable Shopify item", quantity: 1 }],
  checkoutUrl: "https://shop.myshopify.com/recover?key=durable",
  detectedAt: new Date("2026-09-01T08:00:00.000Z"),
};
const shop = {
  id: "shop-1",
  status: "ACTIVE",
  onboardingCompleted: true,
  subscription: { status: "ACTIVE", lastProviderLifecycleState: "UPDATED" },
};
const currentCheckout = {
  abandonedCheckoutUrl: "https://shop.myshopify.com/recover?key=current",
  currencyCode: "GBP",
  totalPrice: "42.00",
  lineItems: [{ title: "Current Shopify item", quantity: 2 }],
};

function createHarness({
  shopResult = shop,
  eligibility = { allowed: true, shopId: "shop-1" },
  pendingResult = { outcome: "not-found" },
  recovery = activeRecovery,
  lookupOutcome = { kind: "found", checkout: currentCheckout },
  updatedCount = 1,
  resumeSchedule = vi.fn(async () => "resume-1"),
  latestActivity = new Date(activityAt),
  recoveryDelayMinutes = 30,
} = {}) {
  const order: string[] = [];
  const checkoutRecovery = {
    findUnique: vi.fn(async () => {
      order.push("latest-activity-read");
      return { lastExternalActivityAt: latestActivity };
    }),
    updateMany: vi.fn(async () => {
      order.push("activity-or-refresh-write");
      return { count: updatedCount };
    }),
  };
  const database = {
    shop: {
      findUnique: vi.fn(async () => {
        order.push("shop-read");
        return shopResult;
      }),
    },
    checkoutRecovery,
    $transaction: vi.fn(async (callback: (transaction: unknown) => unknown) => {
      order.push("transaction");
      return callback({ checkoutRecovery });
    }),
  };
  const pendingRecoveryCandidateService = {
    withCheckoutLock: vi.fn(async (
      _shopId: string,
      _checkoutToken: string,
      callback: () => Promise<unknown>,
    ) => {
      order.push("checkout-lock");
      return callback();
    }),
    scheduleFromCheckoutCreated: vi.fn(async () => pendingResult),
    refreshCandidateActivity: vi.fn(async () => {
      order.push("pending-refresh");
      return pendingResult;
    }),
    scheduleFromCheckoutUpdated: vi.fn(async () => ({ outcome: "enqueued", jobId: "restart-1" })),
  };
  const shopExecutionEligibilityService = {
    resolveShopById: vi.fn(async () => shopResult),
    evaluateResolvedShop: vi.fn(() => {
      order.push("eligibility");
      return eligibility;
    }),
  };
  const findLatestRecovery = vi.fn(async () => {
    order.push("recovery-read");
    return recovery;
  });
  const abandonedCheckoutLookupService = {
    lookup: vi.fn(async () => {
      order.push("shopify-lookup");
      return lookupOutcome;
    }),
  };
  const snapshotBuilder = {
    serializeLineItems: vi.fn((lineItems) => lineItems),
  };
  const recoveryPolicyResolver = {
    resolve: vi.fn(async () => ({ recoveryDelayMinutes })),
  };
  const service = new CheckoutEventOrchestratorService(
    database as never,
    pendingRecoveryCandidateService as never,
    shopExecutionEligibilityService as never,
    findLatestRecovery as never,
    abandonedCheckoutLookupService as never,
    snapshotBuilder as never,
    { schedule: resumeSchedule } as never,
    recoveryPolicyResolver as never,
  );
  return {
    order,
    database,
    pendingRecoveryCandidateService,
    shopExecutionEligibilityService,
    findLatestRecovery,
    abandonedCheckoutLookupService,
    snapshotBuilder,
    service,
    resumeSchedule,
    recoveryPolicyResolver,
  };
}

describe("CheckoutEventOrchestratorService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("schedules checkout-created events through the pending-candidate owner", async () => {
    const scheduled = {
      outcome: "enqueued",
      delayMinutes: 45,
      jobId: "candidate-1",
      shopDomain: event.shopDomain,
    };
    const harness = createHarness({ pendingResult: scheduled });

    await expect(harness.service.handleCheckoutCreatedContract({
      ...event,
      cartToken: "cart-1",
      checkoutCreatedAt: "2026-10-03T07:00:00.000Z",
      abandonedCheckoutUrl: "https://shop.myshopify.com/recover?key=event",
    })).resolves.toEqual({
      kind: "scheduled",
      outcome: "enqueued",
      delayMinutes: 45,
      shopDomain: event.shopDomain,
      checkoutToken: event.checkoutToken,
      source: "v2",
    });
    expect(harness.pendingRecoveryCandidateService.scheduleFromCheckoutCreated).toHaveBeenCalledOnce();
    expect(harness.findLatestRecovery).not.toHaveBeenCalled();
  });

  it.each([
    ["discarded-shop-unavailable", "shop-unavailable"],
    ["discarded-subscription-frozen", "subscription-frozen"],
  ])("maps checkout-created %s to its contract result", async (outcome, reason) => {
    const harness = createHarness({ pendingResult: { outcome, shopDomain: event.shopDomain } });

    await expect(harness.service.handleCheckoutCreatedContract({
      ...event,
      cartToken: null,
      checkoutCreatedAt: null,
      abandonedCheckoutUrl: null,
    })).resolves.toMatchObject({ kind: "ignored", reason, source: "v2" });
  });

  it("checks the exact shop row and eligibility before pending candidate refresh", async () => {
    const harness = createHarness();

    await harness.service.handleCheckoutUpdatedContract(event);

    expect(harness.database.shop.findUnique).toHaveBeenCalledWith({
      where: { domain: event.shopDomain },
      select: {
        id: true,
        status: true,
        platform: true,
        onboardingCompleted: true,
        subscription: {
          select: { status: true, lastProviderLifecycleState: true },
        },
      },
    });
    expect(harness.shopExecutionEligibilityService.evaluateResolvedShop).toHaveBeenCalledWith(
      shop,
      "recovery",
    );
    expect(harness.order.slice(0, 3)).toEqual(["shop-read", "eligibility", "pending-refresh"]);
  });

  it("returns a matching pending candidate before durable recovery or Shopify reads", async () => {
    const harness = createHarness({ pendingResult: { outcome: "rescheduled", jobId: "candidate-1" } });

    await expect(harness.service.handleCheckoutUpdatedContract(event)).resolves.toEqual({
      kind: "pending",
      outcome: "rescheduled",
      jobId: "candidate-1",
    });
    expect(harness.findLatestRecovery).not.toHaveBeenCalled();
    expect(harness.abandonedCheckoutLookupService.lookup).not.toHaveBeenCalled();
    expect(harness.order).toEqual(["shop-read", "eligibility", "pending-refresh"]);
  });

  it("discards a checkout update with no durable recovery before Shopify lookup", async () => {
    const harness = createHarness({ recovery: null });

    await expect(harness.service.handleCheckoutUpdatedContract(event)).resolves.toEqual({
      kind: "discarded",
      reason: "recovery-not-found",
    });
    expect(harness.abandonedCheckoutLookupService.lookup).not.toHaveBeenCalled();
    expect(harness.database.checkoutRecovery.updateMany).not.toHaveBeenCalled();
  });

  it.each(["COMPLETED", "CANCELLED"])("never reopens terminal recovery %s", async (status) => {
    const harness = createHarness({ recovery: { ...activeRecovery, status } });

    await expect(harness.service.handleCheckoutUpdatedContract(event)).resolves.toEqual({
      kind: "ignored",
      reason: `terminal-${status.toLowerCase()}`,
    });
    expect(harness.abandonedCheckoutLookupService.lookup).not.toHaveBeenCalled();
    expect(harness.database.checkoutRecovery.updateMany).not.toHaveBeenCalled();
  });

  it("refreshes an updated DETECTED recovery before scheduling policy-delayed re-entry", async () => {
    const recovery = {
      ...activeRecovery,
      status: "DETECTED",
      admissionBlockReason: null,
    };
    const latestActivity = new Date(activityAt);
    const harness = createHarness({ recovery, latestActivity, recoveryDelayMinutes: 45 });
    harness.resumeSchedule.mockImplementation(async () => {
      harness.order.push("resume-schedule");
      return "resume-1";
    });

    await expect(harness.service.handleCheckoutUpdatedContract(event)).resolves.toEqual({
      kind: "pending",
      outcome: "suppression-resume-scheduled",
      jobId: "resume-1",
    });
    expect(harness.resumeSchedule).toHaveBeenCalledWith({
      shopId: shop.id,
      recoveryId: recovery.id,
      trigger: `recipient-suppression-${recovery.id}-checkout-update-${latestActivity.getTime()}`,
    }, new Date(latestActivity.getTime() + 45 * 60_000));
    expect(harness.database.checkoutRecovery.updateMany).toHaveBeenCalledWith({
      where: {
        id: recovery.id,
        status: { in: ["DETECTED", "MESSAGE_SENT", "ENGAGED"] },
        lastExternalActivityAt: { lt: new Date(activityAt) },
      },
      data: { lastExternalActivityAt: new Date(activityAt) },
    });
    expect(harness.abandonedCheckoutLookupService.lookup).toHaveBeenCalledOnce();
    expect(harness.database.$transaction).toHaveBeenCalledOnce();
    expect(harness.database.checkoutRecovery.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: recovery.id, status: { in: ["DETECTED", "MESSAGE_SENT", "ENGAGED"] } },
      data: {
        currency: currentCheckout.currencyCode,
        totalPrice: currentCheckout.totalPrice,
        checkoutUrl: currentCheckout.abandonedCheckoutUrl,
        lineItems: currentCheckout.lineItems,
      },
    });
    expect(harness.order.indexOf("transaction")).toBeLessThan(harness.order.indexOf("latest-activity-read"));
    expect(harness.order.lastIndexOf("activity-or-refresh-write")).toBeLessThan(
      harness.order.indexOf("resume-schedule"),
    );
    expect(harness.recoveryPolicyResolver.resolve).toHaveBeenCalledWith(shop.id);
  });

  it("schedules a new pending generation from durable EXPIRED recovery state", async () => {
    const expiredRecovery = { ...activeRecovery, status: "EXPIRED" };
    const harness = createHarness({ recovery: expiredRecovery });

    await expect(harness.service.handleCheckoutUpdatedContract(event)).resolves.toEqual({
      kind: "pending",
      outcome: "enqueued",
      jobId: "restart-1",
    });
    expect(harness.pendingRecoveryCandidateService.scheduleFromCheckoutUpdated).toHaveBeenCalledWith({
      shopDomain: event.shopDomain,
      checkoutToken: event.checkoutToken,
      cartToken: expiredRecovery.cartToken,
      checkoutCreatedAt: expiredRecovery.detectedAt.toISOString(),
      abandonedCheckoutUrl: expiredRecovery.checkoutUrl,
      activityAt,
    });
    expect(harness.abandonedCheckoutLookupService.lookup).not.toHaveBeenCalled();
    expect(harness.database.checkoutRecovery.updateMany).not.toHaveBeenCalled();
  });

  it("records monotonic activity before looking up and refreshing from current Shopify data", async () => {
    const harness = createHarness();

    await expect(harness.service.handleCheckoutUpdatedContract(event)).resolves.toEqual({
      kind: "refreshed",
      recoveryId: activeRecovery.id,
      status: activeRecovery.status,
    });
    expect(harness.order).toEqual([
      "shop-read",
      "eligibility",
      "pending-refresh",
      "recovery-read",
      "checkout-lock",
      "activity-or-refresh-write",
      "shopify-lookup",
      "transaction",
      "activity-or-refresh-write",
    ]);
    expect(harness.database.checkoutRecovery.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: activeRecovery.id,
        status: { in: ["DETECTED", "MESSAGE_SENT", "ENGAGED"] },
        lastExternalActivityAt: { lt: new Date(activityAt) },
      },
      data: { lastExternalActivityAt: new Date(activityAt) },
    });
    expect(harness.abandonedCheckoutLookupService.lookup).toHaveBeenCalledWith({
      shopId: shop.id,
      shopDomain: event.shopDomain,
      checkoutToken: event.checkoutToken,
      cartToken: activeRecovery.cartToken,
      abandonedCheckoutUrl: activeRecovery.checkoutUrl,
      checkoutCreatedAt: activeRecovery.detectedAt.toISOString(),
    });
    expect(harness.database.checkoutRecovery.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: activeRecovery.id, status: { in: ["DETECTED", "MESSAGE_SENT", "ENGAGED"] } },
      data: {
        currency: currentCheckout.currencyCode,
        totalPrice: currentCheckout.totalPrice,
        checkoutUrl: currentCheckout.abandonedCheckoutUrl,
        lineItems: currentCheckout.lineItems,
      },
    });
  });

  it("throws provider failures after recording activity and does not refresh the recovery", async () => {
    const harness = createHarness({ lookupOutcome: { kind: "provider-error", message: "Shopify unavailable" } });

    await expect(harness.service.handleCheckoutUpdatedContract(event)).rejects.toThrow(
      `Abandoned checkout provider error while refreshing recovery ${activeRecovery.id}: Shopify unavailable`,
    );
    expect(harness.database.checkoutRecovery.updateMany).toHaveBeenCalledOnce();
    expect(harness.order.indexOf("activity-or-refresh-write")).toBeLessThan(harness.order.indexOf("shopify-lookup"));
  });

  it.each([
    ["not-found", { kind: "not-found" }],
    ["ambiguous", { kind: "ambiguous", matched: 2 }],
    ["bounded-limit-exceeded", { kind: "bounded-limit-exceeded", candidateCount: 21 }],
  ])("discards a %s Shopify lookup without basket refresh", async (_kind, lookupOutcome) => {
    const harness = createHarness({ lookupOutcome });

    await expect(harness.service.handleCheckoutUpdatedContract(event)).resolves.toEqual({
      kind: "discarded",
      reason: `lookup-${_kind}`,
    });
    expect(harness.database.checkoutRecovery.updateMany).toHaveBeenCalledOnce();
    expect(harness.database.$transaction).not.toHaveBeenCalled();
  });

  it("ignores a refresh whose status-guarded update loses a transition race", async () => {
    const harness = createHarness({ updatedCount: 0 });

    await expect(harness.service.handleCheckoutUpdatedContract(event)).resolves.toEqual({
      kind: "ignored",
      reason: "already-transitioned",
    });
  });

  it("keeps external activity monotonic and limited to active recovery statuses", async () => {
    const harness = createHarness();
    const timestamp = new Date(activityAt);

    await harness.service.recordExternalActivity(activeRecovery.id, timestamp, {
      shopId: shop.id,
      checkoutToken: event.checkoutToken,
    });

    expect(harness.pendingRecoveryCandidateService.withCheckoutLock).toHaveBeenCalledWith(
      shop.id,
      event.checkoutToken,
      expect.any(Function),
    );
    expect(harness.database.checkoutRecovery.updateMany).toHaveBeenCalledWith({
      where: {
        id: activeRecovery.id,
        status: { in: ["DETECTED", "MESSAGE_SENT", "ENGAGED"] },
        lastExternalActivityAt: { lt: timestamp },
      },
      data: { lastExternalActivityAt: timestamp },
    });
  });

  it("refreshes only pending cart activity without Shopify lookup or recovery creation", async () => {
    const harness = createHarness({ pendingResult: { outcome: "cancelled", jobId: "candidate-cart" } });

    await expect(harness.service.handleCartActivityContract({
      shopId: shop.id,
      shopDomain: event.shopDomain,
      cartToken: "cart-1",
      isEmpty: true,
      activityAt,
    })).resolves.toEqual({ kind: "pending", outcome: "cancelled", jobId: "candidate-cart" });
    expect(harness.pendingRecoveryCandidateService.refreshCandidateActivity).toHaveBeenCalledWith({
      shopId: shop.id,
      checkoutToken: null,
      cartToken: "cart-1",
      activityAt,
      isEmpty: true,
    });
    expect(harness.abandonedCheckoutLookupService.lookup).not.toHaveBeenCalled();
    expect(harness.findLatestRecovery).not.toHaveBeenCalled();
  });

  it("stops unavailable or ineligible shops before refreshing cart activity", async () => {
    const unavailable = createHarness({ shopResult: null });
    await expect(unavailable.service.handleCartActivityContract({
      shopId: shop.id,
      shopDomain: event.shopDomain,
      cartToken: "cart-1",
      isEmpty: false,
      activityAt,
    })).resolves.toEqual({ kind: "ignored", reason: "shop-unavailable" });
    expect(unavailable.pendingRecoveryCandidateService.refreshCandidateActivity).not.toHaveBeenCalled();

    const denied = createHarness({ eligibility: { allowed: false, shopId: shop.id, reason: "CONTRACT_REQUIRED" } });
    await expect(denied.service.handleCartActivityContract({
      shopId: shop.id,
      shopDomain: event.shopDomain,
      cartToken: "cart-1",
      isEmpty: false,
      activityAt,
    })).resolves.toEqual({ kind: "ignored", reason: "contract-required" });
    expect(denied.pendingRecoveryCandidateService.refreshCandidateActivity).not.toHaveBeenCalled();
  });
});
