import { beforeEach, describe, expect, it, vi } from "vitest";
import { BillingPlanKind, SubscriptionProjectionStatus } from "@prisma/client";
import { APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS } from "@modainteract/moda-interact-shared/billing";
import type { BackgroundRuntimeConfigSnapshot } from "../../../../src/runtime/background-runtime-config.js";
import type { PartnerSubscription } from "../../../../src/providers/shopify-partner-billing.provider.js";
import { BillingCycleReconciliationService } from "../../../../src/services/billing-subscription-reconciliation/billing-cycle-reconciliation.service.js";
import type { BillingCycleReconciliationInput } from "../../../../src/services/billing-subscription-reconciliation/billing-cycle-reconciliation.service.js";
import { FREE_CYCLE_DISCOVERY_RETRY_MS, ROLLOVER_RETRY_MS } from "../../../../src/services/billing-subscription-reconciliation/reconciliation-timing.js";

const dependencyMocks = vi.hoisted(() => ({
  ensureProjection: vi.fn(),
  transition: vi.fn(),
}));

vi.mock("../../../../src/services/current-billing-period-projection.service.js", () => ({
  ensureCurrentBillingPeriodProjection: dependencyMocks.ensureProjection,
}));

vi.mock("../../../../src/services/same-plan-billing-period-rollover.service.js", () => ({
  SamePlanBillingPeriodRolloverService: class {
    private readonly afterTransitionCommitted?: (input: any, result: any) => unknown;

    constructor(_database: unknown, afterTransitionCommitted?: (input: any, result: any) => unknown) {
      this.afterTransitionCommitted = afterTransitionCommitted;
    }

    async transition(input: unknown) {
      const result = await dependencyMocks.transition(input);
      if (result.kind === "transitioned") await this.afterTransitionCommitted?.(input, result);
      return result;
    }
  },
}));

const periodStart = new Date("2026-09-01T00:00:00.000Z");
const periodEnd = new Date("2026-10-01T00:00:00.000Z");
const scheduledAt = new Date("2026-09-24T00:00:00.000Z");
const currentTime = new Date("2026-09-15T00:00:00.000Z");
const runtimeConfig = { version: 7 } as unknown as BackgroundRuntimeConfigSnapshot;

const plan = {
  id: "plan-1",
  active: true,
  name: "Metered plan",
  kind: BillingPlanKind.PAID_METERED,
  shopifyPlanHandle: "paid-plan",
  recoveryCreditPackEnabled: false,
  shopifyUsageEventHandle: "usage-handle",
  shopifyRecoveryCreditPackEventHandle: null,
  includedRecoveryConversationAllowance: 3,
};

const provider: PartnerSubscription = {
  planHandle: "paid-plan",
  usageEventHandles: ["usage-handle"],
  pendingPlanHandle: null,
  pendingEffectiveAt: null,
  status: "ACTIVE",
  currentPeriodStart: periodStart,
  currentPeriodEnd: periodEnd,
  trialEndsAt: null,
  cancelAtPeriodEnd: false,
  providerSubscriptionId: "provider-subscription-1",
  providerUsageSnapshot: [],
  providerUsagePricingSnapshot: [],
};

function makeInput(overrides: Partial<BillingCycleReconciliationInput> = {}): BillingCycleReconciliationInput {
  return {
    shopId: "shop-1",
    kind: "rollover",
    expected: {
      subscriptionId: "subscription-1",
      currentPlanId: plan.id,
      billingPeriodId: "period-1",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      nextReconcileAt: scheduledAt,
    },
    provider,
    plan,
    runtimeConfig,
    subscription: {
      planId: plan.id,
      billingPeriodId: "period-1",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      lastSyncErrorCode: null,
    },
    ...overrides,
  };
}

function createHarness(options: {
  now?: () => Date;
  publisher?: { publishDue: ReturnType<typeof vi.fn> };
  capacity?: { schedule: ReturnType<typeof vi.fn> };
  updateCount?: number;
  scheduledRow?: Record<string, unknown> | null;
} = {}) {
  const transaction = {
    $queryRaw: vi.fn(async () => []),
    subscription: {
      findUnique: vi.fn(async () => ({
        status: SubscriptionProjectionStatus.ACTIVE,
        planId: plan.id,
        billingPeriodId: null,
        pendingPlanId: null,
        pendingShopifyPlanHandle: null,
        pendingEffectiveAt: null,
        nextReconcileAt: scheduledAt,
      })),
      update: vi.fn(async () => ({})),
    },
  };
  const database = {
    billingPlan: {
      findUnique: vi.fn(async () => ({ id: "pending-plan", active: true })),
    },
    subscription: {
      updateMany: vi.fn(async () => ({ count: options.updateCount ?? 1 })),
      findUnique: vi.fn(async () => options.scheduledRow ?? {
        id: "subscription-1",
        status: SubscriptionProjectionStatus.ACTIVE,
        planId: plan.id,
        billingPeriodId: "period-1",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        nextReconcileAt: scheduledAt,
      }),
    },
    $transaction: vi.fn(async (operation: (transaction: typeof transaction) => unknown) => operation(transaction)),
  };
  const queue = { publishNext: vi.fn(async () => undefined) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const publisher = options.publisher ?? { publishDue: vi.fn(async () => ({})) };
  const capacity = options.capacity ?? { schedule: vi.fn(async () => "scheduled") };
  const service = new BillingCycleReconciliationService(
    database as never,
    queue,
    logger as never,
    options.now ?? (() => currentTime),
    publisher,
    capacity,
  );
  return { service, database, transaction, queue, logger, publisher, capacity };
}

describe("BillingCycleReconciliationService", () => {
  beforeEach(() => {
    dependencyMocks.ensureProjection.mockReset();
    dependencyMocks.ensureProjection.mockResolvedValue({ kind: "READY", billingPeriodId: "period-new", repaired: true });
    dependencyMocks.transition.mockReset();
  });

  it("retries Free cycle discovery with the exact discovery interval and CAS", async () => {
    const harness = createHarness();
    const input = makeInput({ kind: "cycle-discovery", provider: null });

    await harness.service.reconcileAccepted(input);

    const call = harness.database.subscription.updateMany.mock.calls[0]?.[0];
    expect(call.where).toEqual({
      id: input.expected.subscriptionId,
      status: { in: [SubscriptionProjectionStatus.ACTIVE, SubscriptionProjectionStatus.TRIALING] },
      planId: input.expected.currentPlanId,
      billingPeriodId: null,
      pendingPlanId: null,
      pendingShopifyPlanHandle: null,
      pendingEffectiveAt: null,
      nextReconcileAt: scheduledAt,
    });
    expect(call.data.nextReconcileAt).toEqual(new Date(currentTime.getTime() + FREE_CYCLE_DISCOVERY_RETRY_MS));
    expect(harness.queue.publishNext).toHaveBeenCalledExactlyOnceWith(
      input.shopId,
      input.expected.subscriptionId,
      call.data.nextReconcileAt,
    );
  });

  it("projects a pack-enabled Free provider cycle under the canonical subscription lock", async () => {
    const harness = createHarness();
    const freePlan = { ...plan, kind: BillingPlanKind.FREE, recoveryCreditPackEnabled: true };
    const freeProvider = { ...provider, planHandle: freePlan.shopifyPlanHandle };

    await harness.service.reconcileAccepted(makeInput({ kind: "cycle-discovery", plan: freePlan, provider: freeProvider }));

    expect(harness.transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(dependencyMocks.ensureProjection).toHaveBeenCalledWith(
      harness.transaction,
      expect.objectContaining({
        shopId: "shop-1",
        subscriptionId: "subscription-1",
        providerPlanHandle: freeProvider.planHandle,
        plan: freePlan,
      }),
    );
    expect(harness.transaction.subscription.update).toHaveBeenCalledWith({
      where: { id: "subscription-1" },
      data: expect.objectContaining({
        billingPeriodId: "period-new",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        providerSubscriptionId: freeProvider.providerSubscriptionId,
      }),
    });
    expect(harness.queue.publishNext).toHaveBeenCalledExactlyOnceWith(
      "shop-1",
      "subscription-1",
      new Date(Math.max(currentTime.getTime(), periodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS)),
    );
  });

  it("records projection conflicts as BILLING_PERIOD_PLAN_CONFLICT", async () => {
    dependencyMocks.ensureProjection.mockResolvedValueOnce({ kind: "CONFLICT", billingPeriodId: "period-new", reason: "HANDLE_MISMATCH" });
    const harness = createHarness();

    await harness.service.reconcileAccepted(makeInput({ kind: "cycle-discovery", plan: { ...plan, kind: BillingPlanKind.FREE, recoveryCreditPackEnabled: true } }));

    expect(harness.transaction.subscription.update).toHaveBeenCalledWith({
      where: { id: "subscription-1" },
      data: expect.objectContaining({ status: SubscriptionProjectionStatus.SYNC_ERROR, lastSyncErrorCode: "BILLING_PERIOD_PLAN_CONFLICT" }),
    });
    expect(harness.queue.publishNext).toHaveBeenCalledWith("shop-1", "subscription-1", new Date(currentTime.getTime() + ROLLOVER_RETRY_MS));
  });

  it("projects pending plan truth before the pre-close branch", async () => {
    const harness = createHarness();
    const pendingProvider = { ...provider, pendingPlanHandle: "new-plan", pendingEffectiveAt: new Date("2026-09-29T00:00:00.000Z") };

    await harness.service.reconcileAccepted(makeInput({ provider: pendingProvider }));

    expect(harness.database.billingPlan.findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { shopifyPlanHandle: "new-plan" },
      select: { id: true, active: true },
    });
    expect(harness.database.subscription.findUnique).not.toHaveBeenCalled();
    expect(harness.publisher.publishDue).not.toHaveBeenCalled();
    expect(harness.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ pendingShopifyPlanHandle: "new-plan", pendingPlanId: "pending-plan", pendingEffectiveAt: pendingProvider.pendingEffectiveAt }),
    }));
  });

  it("projects cancellation-only provider truth for the unchanged current cycle", async () => {
    const harness = createHarness();
    const cancellationProvider = { ...provider, cancelAtPeriodEnd: true };

    await harness.service.reconcileAccepted(makeInput({ provider: cancellationProvider }));

    expect(harness.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ cancelAtPeriodEnd: true, pendingShopifyPlanHandle: null, pendingPlanId: null }),
    }));
    expect(harness.database.billingPlan.findUnique).not.toHaveBeenCalled();
  });

  it("records cycle-discovery provider failures with the existing error and retry", async () => {
    const harness = createHarness();
    const input = makeInput({ kind: "cycle-discovery" });
    const error = new Error("partner unavailable");

    await harness.service.recordProviderFailure(input.shopId, input.kind, input.expected, error);

    expect(harness.logger.error).toHaveBeenCalledWith("billing.subscription_reconciliation.provider_failed", {
      shopId: input.shopId,
      subscriptionId: input.expected.subscriptionId,
      errorMessage: "partner unavailable",
    });
    expect(harness.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        nextReconcileAt: new Date(currentTime.getTime() + FREE_CYCLE_DISCOVERY_RETRY_MS),
        lastSyncErrorCode: "PARTNER_API_ERROR",
      }),
    }));
  });

  it.each([
    [null, false],
    ["PRE_CLOSE_USAGE_FLUSH_FAILED", true],
    ["PARTNER_API_ERROR", false],
  ] as const)("clears only an existing pre-close flush error in the inline provider-truth branch", async (lastSyncErrorCode, shouldClear) => {
    const drainWindowOffset = Math.max(1000, Math.floor(APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS / 2));
    const now = new Date(periodEnd.getTime() - drainWindowOffset);
    const harness = createHarness({ now: () => now });
    const pendingProvider = { ...provider, pendingPlanHandle: "new-plan", pendingEffectiveAt: scheduledAt };

    await harness.service.reconcileAccepted(makeInput({
      provider: pendingProvider,
      subscription: { ...makeInput().subscription, lastSyncErrorCode },
    }));

    const data = harness.database.subscription.updateMany.mock.calls[0][0].data;
    expect(harness.publisher.publishDue).toHaveBeenCalledExactlyOnceWith({ billingPeriodId: "period-1", runtimeConfig });
    if (shouldClear) {
      expect(data).toMatchObject({ lastSyncErrorCode: null, lastSyncErrorAt: null });
    } else {
      expect(data).not.toHaveProperty("lastSyncErrorCode");
      expect(data).not.toHaveProperty("lastSyncErrorAt");
    }
  });

  it("caps inline flush-failure retries at the exact period end", async () => {
    const now = new Date(periodEnd.getTime() - 30_000);
    const publisher = { publishDue: vi.fn(async () => { throw new Error("flush failed"); }) };
    const harness = createHarness({ now: () => now, publisher });
    const pendingProvider = { ...provider, pendingPlanHandle: "new-plan", pendingEffectiveAt: scheduledAt };

    await harness.service.reconcileAccepted(makeInput({ provider: pendingProvider }));

    expect(publisher.publishDue).toHaveBeenCalledWith({ billingPeriodId: "period-1", runtimeConfig });
    expect(harness.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        nextReconcileAt: periodEnd,
        lastSyncErrorCode: "PRE_CLOSE_USAGE_FLUSH_FAILED",
      }),
    }));
  });

  it("schedules before the drain window and preserves unconditional pre-close error clearing on success", async () => {
    const now = new Date(periodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS - 1000);
    const harness = createHarness({ now: () => now });

    await harness.service.reconcileAccepted(makeInput({ provider: null }));

    expect(harness.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { nextReconcileAt: new Date(periodEnd.getTime() - APP_PRICING_BILLING_PERIOD_DRAIN_WINDOW_MS) },
    }));
    expect(harness.publisher.publishDue).not.toHaveBeenCalled();

    const insideNow = new Date(periodEnd.getTime() - 1000);
    const insideHarness = createHarness({ now: () => insideNow });
    await insideHarness.service.reconcileAccepted(makeInput({ provider: null }));
    expect(insideHarness.publisher.publishDue).toHaveBeenCalledExactlyOnceWith({ billingPeriodId: "period-1", runtimeConfig });
    expect(insideHarness.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastSyncErrorCode: null, lastSyncErrorAt: null, nextReconcileAt: periodEnd }),
    }));
  });

  it("applies provider-cycle lag retry without fetching provider data", async () => {
    dependencyMocks.transition.mockResolvedValueOnce({ kind: "provider-cycle-lag", billingPeriodId: "period-1", nextReconcileAt: scheduledAt });
    const harness = createHarness({ now: () => periodEnd });

    await harness.service.reconcileAccepted(makeInput());

    expect(dependencyMocks.transition).toHaveBeenCalledTimes(1);
    expect(harness.database.subscription.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        nextReconcileAt: new Date(periodEnd.getTime() + ROLLOVER_RETRY_MS),
        lastSyncErrorCode: "PROVIDER_CYCLE_LAG",
      }),
    }));
  });

  it("keeps rollover capacity resume best-effort after a committed paid transition", async () => {
    dependencyMocks.transition.mockImplementationOnce(async (_input: unknown) => ({
      kind: "transitioned",
      billingPeriodId: "period-next",
      nextReconcileAt: new Date("2026-10-24T00:00:00.000Z"),
      planKind: BillingPlanKind.PAID_METERED,
    }));
    const capacity = { schedule: vi.fn(async () => { throw new Error("queue unavailable"); }) };
    const harness = createHarness({ capacity, now: () => periodEnd });

    await expect(harness.service.reconcileAccepted(makeInput())).resolves.toBeUndefined();

    expect(capacity.schedule).toHaveBeenCalledExactlyOnceWith({ shopId: "shop-1", trigger: "billing-period-rollover" });
    expect(harness.logger.warn).toHaveBeenCalledWith("billing.recovery_capacity_resume.enqueue_failed", expect.objectContaining({ shopId: "shop-1" }));
    expect(harness.queue.publishNext).toHaveBeenCalledWith("shop-1", "subscription-1", new Date("2026-10-24T00:00:00.000Z"));
  });
});