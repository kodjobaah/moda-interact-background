import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecoveryCapacityResumeProcessorService } from "../../../../src/services/checkout-recovery/recovery-capacity-resume-processor.service.js";
import { RecoveryRecipientSuppressionAdmissionService } from "../../../../src/services/checkout-recovery/recovery-recipient-suppression-admission.service.js";
import { CheckoutEventOrchestratorService } from "../../../../src/services/checkout-recovery/checkout-event-orchestrator.service.js";

const schedule = vi.hoisted(() => vi.fn(async () => "job-id"));
vi.mock("../../../../src/services/recovery-capacity-resume.service.js", () => ({
  recoveryCapacityResumeService: { schedule },
}));

const blockedRecovery = {
  id: "recovery-1",
  shopId: "shop-1",
  checkoutToken: "checkout-1",
  cartToken: "cart-1",
  checkoutUrl: "https://checkout/durable",
  detectedAt: new Date("2026-09-01T00:00:00.000Z"),
  lastExternalActivityAt: new Date("2026-10-10T00:00:00.000Z"),
  generation: 1,
  status: "DETECTED",
  admissionBlockReason: "RECOVERY_CAPACITY_EXHAUSTED",
  updatedAt: new Date("2026-10-10T00:00:00.000Z"),
  customerId: "customer-1",
  shop: { domain: "shop.example", status: "ACTIVE" },
};
const suppressionBlockedRecovery = {
  ...blockedRecovery,
  admissionBlockReason: "WHATSAPP_RECIPIENT_SUPPRESSED",
};

const currentCheckout = {
  createdAt: "2026-09-01T00:00:00.000Z",
  completedAt: null,
  currencyCode: "GBP",
  totalPrice: "42.00",
  abandonedCheckoutUrl: "https://checkout/current",
  customer: null,
  lineItems: [],
  internationalContext: null,
};

function createHarness({
  reads = [blockedRecovery, blockedRecovery, { status: "MESSAGE_SENT", admissionBlockReason: null }],
  lookup = { kind: "found", checkout: currentCheckout },
  allowed = true,
  updateCount = 1,
  resolvedRecipient = null,
  customerRecipient = "15551234567",
  recoveryDelayMinutes = 30,
  now = () => new Date(),
} = {}) {
  const order: string[] = [];
  const readResults = [...reads];
  const database = {
    checkoutRecovery: {
      findUnique: vi.fn(async () => {
        order.push("recovery-read");
        return readResults.shift() ?? null;
      }),
    },
    $transaction: vi.fn(async (callback: (transaction: unknown) => unknown) => {
      order.push("transaction");
      return callback({
        checkoutRecovery: {
          updateMany: vi.fn(async () => {
            order.push("terminal-update");
            return { count: updateCount };
          }),
        },
        checkoutRecoveryStatusHistory: {
          create: vi.fn(async () => {
            order.push("history-create");
            return {};
          }),
        },
      });
    }),
  };
  const pendingRecoveryCandidateService = {
    withCheckoutLock: vi.fn(async (
      _shopId: string,
      _checkoutToken: string,
      callback: () => Promise<unknown>,
    ) => {
      order.push("lock");
      return callback();
    }),
  };
  const shopExecutionEligibilityService = {
    evaluate: vi.fn(async () => {
      order.push("eligibility");
      return allowed ? { allowed: true, shopId: "shop-1" } : {
        allowed: false,
        shopId: "shop-1",
        reason: "SUBSCRIPTION_FROZEN",
      };
    }),
  };
  const abandonedCheckoutLookupService = {
    lookup: vi.fn(async () => {
      order.push("lookup");
      return lookup;
    }),
  };
  const snapshotBuilder = {
    build: vi.fn(async () => ({
      shop: "shop.example",
      checkoutToken: "checkout-1",
      checkoutUrl: "https://checkout/current",
      completedAt: null,
    })),
  };
  const initiate = vi.fn(async () => undefined);
  const recipientResolver = {
    resolve: vi.fn(async () => resolvedRecipient),
    resolveForCustomerInShop: vi.fn(async () => customerRecipient),
  };
  const suppressionAdmission = {
    clearDetectedSuppression: vi.fn(async () => undefined),
  };
  const service = new RecoveryCapacityResumeProcessorService(
    database as never,
    pendingRecoveryCandidateService as never,
    shopExecutionEligibilityService as never,
    abandonedCheckoutLookupService as never,
    snapshotBuilder as never,
    initiate,
    recipientResolver as never,
    suppressionAdmission as never,
    { schedule } as never,
    { resolve: vi.fn(async () => ({ recoveryDelayMinutes })) } as never,
    now,
  );

  return {
    order,
    database,
    pendingRecoveryCandidateService,
    shopExecutionEligibilityService,
    abandonedCheckoutLookupService,
    snapshotBuilder,
    initiate,
    recipientResolver,
    suppressionAdmission,
    service,
  };
}

describe("RecoveryCapacityResumeProcessorService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ignores missing or no-longer-blocked durable recoveries before eligibility work", async () => {
    const harness = createHarness({ reads: [null] });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "ignored",
      reason: "not-capacity-blocked",
    });
    expect(harness.shopExecutionEligibilityService.evaluate).not.toHaveBeenCalled();
    expect(harness.pendingRecoveryCandidateService.withCheckoutLock).not.toHaveBeenCalled();
  });

  it("stops before lookup when execution is denied", async () => {
    const harness = createHarness({ allowed: false });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "ignored",
      reason: "SUBSCRIPTION_FROZEN",
    });
    expect(harness.pendingRecoveryCandidateService.withCheckoutLock).not.toHaveBeenCalled();
    expect(harness.abandonedCheckoutLookupService.lookup).not.toHaveBeenCalled();
  });

  it("reschedules a stale targeted wake-up until the latest activity matures", async () => {
    schedule.mockClear();
    const latestActivity = new Date("2026-10-11T20:00:00.000Z");
    const recentRecovery = {
      ...suppressionBlockedRecovery,
      lastExternalActivityAt: latestActivity,
    };
    let now = new Date("2026-10-11T20:15:00.000Z");
    const harness = createHarness({
      reads: [
        recentRecovery,
        recentRecovery,
        recentRecovery,
        recentRecovery,
        { status: "MESSAGE_SENT", admissionBlockReason: null },
      ],
      now: () => now,
      recoveryDelayMinutes: 30,
    });
    const staleTrigger = `recipient-suppression-recovery-1-checkout-update-${latestActivity.getTime() - 60_000}`;

    await expect(harness.service.resume("recovery-1", staleTrigger)).resolves.toEqual({
      kind: "deferred-activity",
      dueAt: new Date(latestActivity.getTime() + 30 * 60_000),
    });
    const maturityJob = schedule.mock.calls[0]?.[0];
    expect(maturityJob).toEqual({
      shopId: "shop-1",
      recoveryId: "recovery-1",
      trigger: `recipient-suppression-recovery-1-maturity-${latestActivity.getTime()}`,
    });
    expect(schedule.mock.calls[0]?.[1]).toEqual(new Date(latestActivity.getTime() + 30 * 60_000));
    expect(harness.abandonedCheckoutLookupService.lookup).not.toHaveBeenCalled();
    expect(harness.initiate).not.toHaveBeenCalled();

    now = new Date(latestActivity.getTime() + 30 * 60_000);
    await harness.service.resume("recovery-1", maturityJob!.trigger);
    expect(harness.abandonedCheckoutLookupService.lookup).toHaveBeenCalledOnce();
    expect(harness.initiate).toHaveBeenCalledOnce();

    await expect(harness.service.resume("recovery-1", maturityJob!.trigger)).resolves.toMatchObject({
      kind: "ignored",
    });
    expect(harness.initiate).toHaveBeenCalledOnce();
  });

  it("re-reads durable block state and rechecks eligibility after acquiring the checkout lock", async () => {
    const harness = createHarness({
      reads: [blockedRecovery, blockedRecovery],
    });
    harness.shopExecutionEligibilityService.evaluate
      .mockResolvedValueOnce({ allowed: true, shopId: "shop-1" })
      .mockResolvedValueOnce({
        allowed: false,
        shopId: "shop-1",
        reason: "SUBSCRIPTION_FROZEN",
      });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "ignored",
      reason: "SUBSCRIPTION_FROZEN",
    });
    expect(harness.order).toEqual([
      "recovery-read",
      "lock",
      "recovery-read",
    ]);
    expect(harness.shopExecutionEligibilityService.evaluate).toHaveBeenCalledTimes(2);
    expect(harness.abandonedCheckoutLookupService.lookup).not.toHaveBeenCalled();
  });

  it.each([
    ["provider-error", { kind: "provider-error", message: "temporary" }],
    ["ambiguous", { kind: "ambiguous" }],
    ["bounded-limit-exceeded", { kind: "bounded-limit-exceeded" }],
  ] as const)("keeps %s lookup failures retryable", async (_kind, lookup) => {
    const harness = createHarness({ lookup });

    await expect(harness.service.resume("recovery-1")).rejects.toThrow();
    expect(harness.database.$transaction).not.toHaveBeenCalled();
    expect(harness.initiate).not.toHaveBeenCalled();
  });

  it("terminalises not-found in one guarded transaction and records history only after the CAS", async () => {
    const harness = createHarness({
      lookup: { kind: "not-found" },
      reads: [blockedRecovery, blockedRecovery],
    });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "terminal",
      reason: "not-found",
    });
    expect(harness.order).toEqual([
      "recovery-read",
      "eligibility",
      "lock",
      "recovery-read",
      "eligibility",
      "lookup",
      "transaction",
      "terminal-update",
      "history-create",
    ]);
  });

  it("preserves the found return reason quirk for a completed checkout", async () => {
    const harness = createHarness({
      lookup: { kind: "found", checkout: { ...currentCheckout, completedAt: "2026-09-02T00:00:00Z" } },
      reads: [blockedRecovery, blockedRecovery],
    });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "terminal",
      reason: "found",
    });
    expect(harness.database.$transaction).toHaveBeenCalledOnce();
  });

  it("uses the Shop-scoped current phone for generation-one re-entry", async () => {
    const harness = createHarness({
      reads: [blockedRecovery, blockedRecovery, null],
    });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "initiated",
      status: "DETECTED",
    });
    expect(harness.snapshotBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: "shop-1",
        shopDomain: "shop.example",
        checkoutToken: "checkout-1",
        checkoutCreatedAt: blockedRecovery.detectedAt.toISOString(),
      }),
      "shop.example",
      currentCheckout,
    );
    expect(harness.initiate).toHaveBeenCalledOnce();
    expect(harness.recipientResolver.resolve).toHaveBeenCalledWith(expect.objectContaining({ checkoutToken: "checkout-1" }));
    expect(harness.recipientResolver.resolveForCustomerInShop).toHaveBeenCalledWith("customer-1", "shop-1");
    expect(harness.initiate).toHaveBeenCalledWith(expect.any(Object), 1, "15551234567", undefined);
  });

  it("re-evaluates a suppression-blocked recovery from fresh checkout state under its lock", async () => {
    const harness = createHarness({
      reads: [
        suppressionBlockedRecovery,
        suppressionBlockedRecovery,
        { status: "MESSAGE_SENT", admissionBlockReason: null },
      ],
    });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "initiated",
      status: "MESSAGE_SENT",
    });
    expect(harness.order).toEqual([
      "recovery-read",
      "eligibility",
      "lock",
      "recovery-read",
      "eligibility",
      "lookup",
      "recovery-read",
    ]);
    expect(harness.snapshotBuilder.build).toHaveBeenCalledOnce();
    expect(harness.initiate).toHaveBeenCalledOnce();
    expect(harness.initiate.mock.calls[0][2]).toBe("15551234567");
  });

  it("uses a changed current number as an independent recipient key", async () => {
    const harness = createHarness({
      reads: [suppressionBlockedRecovery, suppressionBlockedRecovery, { status: "MESSAGE_SENT", admissionBlockReason: null }],
      resolvedRecipient: "447700900123",
    });

    await harness.service.resume("recovery-1");

    expect(harness.recipientResolver.resolveForCustomerInShop).not.toHaveBeenCalled();
    expect(harness.initiate).toHaveBeenCalledWith(expect.any(Object), 1, "447700900123", undefined);
  });

  it("clears an expired suppression block and does not initiate when no current phone exists", async () => {
    const harness = createHarness({
      reads: [suppressionBlockedRecovery, suppressionBlockedRecovery],
      customerRecipient: null,
    });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "suppressed",
      reason: "no-recipient",
    });

    expect(harness.suppressionAdmission.clearDetectedSuppression).toHaveBeenCalledWith("recovery-1");
    expect(harness.initiate).not.toHaveBeenCalled();
  });

  it("requeues an early targeted wake-up while the original suppression block write is pending", async () => {
    schedule.mockClear();
    const until = new Date(Date.now() + 60_000);
    let unblockFirstWrite!: () => void;
    let firstWriteStarted!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => { unblockFirstWrite = resolve; });
    const firstWriteStartedGate = new Promise<void>((resolve) => { firstWriteStarted = resolve; });
    let updateCount = 0;
    let blockReason: string | null = null;
    const recoveryReads = [
      { ...suppressionBlockedRecovery, admissionBlockReason: null },
      { ...suppressionBlockedRecovery, admissionBlockReason: null },
      { status: "DETECTED", admissionBlockReason: "WHATSAPP_RECIPIENT_SUPPRESSED" },
    ];
    const database = {
      whatsAppRecipientReachability: {
        findUnique: vi.fn(async () => ({ suppressUntil: until })),
      },
      checkoutRecovery: {
        updateMany: vi.fn(async () => {
          updateCount += 1;
          if (updateCount === 1) {
            firstWriteStarted();
            await firstWriteGate;
          }
          blockReason = "WHATSAPP_RECIPIENT_SUPPRESSED";
          return { count: 1 };
        }),
        findUnique: vi.fn(async ({ select }: { select?: Record<string, unknown> }) => {
          if (select?.updatedAt) {
            return {
              status: "DETECTED",
              admissionBlockReason: blockReason,
              updatedAt: suppressionBlockedRecovery.updatedAt,
            };
          }
          const next = recoveryReads.shift();
          return next ? { ...next, admissionBlockReason: next.admissionBlockReason ?? blockReason } : null;
        }),
      },
    };
    const admission = new RecoveryRecipientSuppressionAdmissionService(database as never);
    const initialDeferral = admission.deferDetectedRecovery("recovery-1", "shop-1", until);
    await firstWriteStartedGate;
    const originalWakeup = schedule.mock.calls[0]?.[0];
    expect(originalWakeup).toBeDefined();

    const initiate = vi.fn(async (
      _seed: unknown,
      _generation: number,
      recipient: string,
      wakeupTrigger?: string,
    ) => {
      expect(recipient).toBe("15551234567");
      const decision = await admission.evaluate("shop-1", recipient);
      if (decision.kind === "suppressed") {
        await admission.deferDetectedRecovery("recovery-1", "shop-1", decision.until, wakeupTrigger);
      }
    });
    const processor = new RecoveryCapacityResumeProcessorService(
      database as never,
      { withCheckoutLock: async (_shopId: string, _token: string, callback: () => Promise<unknown>) => callback() } as never,
      { evaluate: async () => ({ allowed: true, shopId: "shop-1" }) } as never,
      { lookup: async () => ({ kind: "found", checkout: currentCheckout }) } as never,
      { build: async () => ({ shop: "shop.example", checkoutToken: "checkout-1" }) } as never,
      initiate,
      {
        resolve: async () => "15551234567",
        resolveForCustomerInShop: async () => "15551234567",
      } as never,
      admission,
    );

    await expect(processor.resume("recovery-1", originalWakeup!.trigger)).resolves.toMatchObject({
      kind: "suppressed",
      reason: "WHATSAPP_RECIPIENT_SUPPRESSED",
    });
    const childWakeup = schedule.mock.calls[1]?.[0];
    expect(childWakeup).toBeDefined();
    expect(childWakeup!.trigger).not.toBe(originalWakeup!.trigger);
    expect(childWakeup!.recoveryId).toBe("recovery-1");
    expect(initiate).toHaveBeenCalledOnce();
    expect(updateCount).toBe(2);

    unblockFirstWrite();
    await expect(initialDeferral).resolves.toBe(true);
  });

  it.each([
    ["no-current-recipient", { kind: "found", checkout: currentCheckout }, null],
    ["terminal-checkout", { kind: "not-found" }, "15551234567"],
  ] as const)("prevents a late suppression write after an early %s wake-up", async (_case, lookup, recipient) => {
    schedule.mockClear().mockResolvedValue("job-id");
    const until = new Date(Date.now() + 60_000);
    let suppressionUntil: Date | null = until;
    let currentRecipient = recipient;
    let attempts = 0;
    let charges = 0;
    let sends = 0;
    let releaseBlockWrite!: () => void;
    let signalBlockWrite!: () => void;
    const blockWriteGate = new Promise<void>((resolve) => { releaseBlockWrite = resolve; });
    const blockWriteStarted = new Promise<void>((resolve) => { signalBlockWrite = resolve; });
    const current = {
      ...suppressionBlockedRecovery,
      admissionBlockReason: null,
      lastExternalActivityAt: suppressionBlockedRecovery.lastExternalActivityAt,
    };
    const updateMany = vi.fn(async ({ where, data }: {
      where: {
        id: string;
        status: string | { in: string[] };
        updatedAt?: Date;
        lastExternalActivityAt?: { lt: Date };
        admissionBlockReason?: { in: Array<string | null> };
      };
      data: Record<string, unknown>;
    }) => {
      const allowedStatuses = typeof where.status === "string" ? [where.status] : where.status.in;
      if (!allowedStatuses.includes(current.status) || where.id !== current.id) return { count: 0 };
      if (where.admissionBlockReason &&
        !where.admissionBlockReason.in.includes(current.admissionBlockReason)) return { count: 0 };
      if (data.admissionBlockReason === "WHATSAPP_RECIPIENT_SUPPRESSED") {
        signalBlockWrite();
        await blockWriteGate;
      }
      if (current.status !== "DETECTED") return { count: 0 };
      if (where.updatedAt && where.updatedAt.getTime() !== current.updatedAt.getTime()) return { count: 0 };
      Object.assign(current, data);
      return { count: 1 };
    });
    const database = {
      whatsAppRecipientReachability: {
        findUnique: vi.fn(async () => ({ suppressUntil: suppressionUntil })),
      },
      checkoutRecovery: {
        findUnique: vi.fn(async ({ select }: { select?: Record<string, unknown> }) => {
          if (select?.updatedAt && !select?.shop) {
            return {
              status: current.status,
              admissionBlockReason: current.admissionBlockReason,
              updatedAt: current.updatedAt,
            };
          }
          if (select?.lastExternalActivityAt && Object.keys(select).length === 1) {
            return { lastExternalActivityAt: current.lastExternalActivityAt };
          }
          return { ...current };
        }),
        updateMany,
      },
      shop: { findUnique: vi.fn(async () => ({
        id: "shop-1",
        status: "ACTIVE",
        platform: "SHOPIFY",
        onboardingCompleted: true,
        subscription: { status: "ACTIVE", lastProviderLifecycleState: "UPDATED" },
      })) },
      $transaction: vi.fn(async (callback: (transaction: unknown) => unknown) => callback({
        checkoutRecovery: { updateMany },
        checkoutRecoveryStatusHistory: { create: vi.fn(async () => ({})) },
      })),
    };
    const admission = new RecoveryRecipientSuppressionAdmissionService(database as never);
    const originalDeferral = admission.deferDetectedRecovery("recovery-1", "shop-1", until);
    await blockWriteStarted;
    const wakeupTrigger = schedule.mock.calls[0]?.[0].trigger;
    expect(wakeupTrigger).toBeDefined();

    const initiate = vi.fn(async (
      _seed: unknown,
      _generation: number,
      currentCanonicalRecipient: string,
      wakeup?: string,
    ) => {
      const decision = await admission.evaluate("shop-1", currentCanonicalRecipient);
      if (decision.kind === "suppressed") {
        await admission.deferDetectedRecovery("recovery-1", "shop-1", decision.until, wakeup);
        return;
      }
      await admission.clearDetectedSuppression("recovery-1");
      attempts += 1;
      charges += 1;
      sends += 1;
    });
    const processor = new RecoveryCapacityResumeProcessorService(
      database as never,
      { withCheckoutLock: async (_shopId: string, _token: string, callback: () => Promise<unknown>) => callback() } as never,
      { evaluate: async () => ({ allowed: true, shopId: "shop-1" }) } as never,
      { lookup: async () => lookup } as never,
      { build: async () => ({ shop: "shop.example", checkoutToken: "checkout-1" }) } as never,
      initiate,
      {
        resolve: async () => currentRecipient,
        resolveForCustomerInShop: async () => null,
      } as never,
      admission,
      { schedule } as never,
      { resolve: vi.fn(async () => ({ recoveryDelayMinutes: 30 })) } as never,
      () => new Date("2026-10-11T21:00:00.000Z"),
    );

    const result = await processor.resume("recovery-1", wakeupTrigger);
    expect(result.kind).toBe(recipient ? "terminal" : "suppressed");
    expect(initiate).not.toHaveBeenCalled();
    expect(current.status).toBe(recipient ? "CANCELLED" : "DETECTED");
    expect(current.admissionBlockReason).toBeNull();

    releaseBlockWrite();
    await expect(originalDeferral).resolves.toBe(false);
    expect(current.status).toBe(recipient ? "CANCELLED" : "DETECTED");
    expect(current.admissionBlockReason).toBeNull();

    if (recipient === null) {
      expect(current.updatedAt.getTime()).toBeGreaterThan(suppressionBlockedRecovery.updatedAt.getTime());
      const eventTime = "2026-10-11T20:00:00.000Z";
      const checkoutEvents = new CheckoutEventOrchestratorService(
        database as never,
        { refreshCandidateActivity: vi.fn(async () => ({ outcome: "not-found" })) } as never,
        { evaluateResolvedShop: vi.fn(() => ({ allowed: true, shopId: "shop-1" })) } as never,
        vi.fn(async () => ({ ...current })) as never,
        { lookup: vi.fn(async () => ({ kind: "found", checkout: currentCheckout })) } as never,
        { serializeLineItems: vi.fn((items) => items) } as never,
        { schedule } as never,
        { resolve: vi.fn(async () => ({ recoveryDelayMinutes: 30 })) } as never,
      );
      const checkoutResult = await checkoutEvents.handleCheckoutUpdatedContract({
        shopDomain: "shop.example",
        checkoutToken: "checkout-1",
        activityAt: eventTime,
      });
      expect(checkoutResult).toEqual({
        kind: "pending",
        outcome: "suppression-resume-scheduled",
        jobId: "job-id",
      });
      const updateWakeup = schedule.mock.calls[1]?.[0];
      expect(updateWakeup?.trigger).toContain("recipient-suppression-recovery-1-checkout-update-");

      currentRecipient = "447700900123";
      await expect(processor.resume("recovery-1", updateWakeup!.trigger)).resolves.toMatchObject({
        kind: "suppressed",
        reason: "WHATSAPP_RECIPIENT_SUPPRESSED",
      });
      expect(initiate).toHaveBeenCalledWith(expect.any(Object), 1, currentRecipient, updateWakeup!.trigger);
      expect(attempts).toBe(0);
      expect(charges).toBe(0);
      expect(sends).toBe(0);
      expect(current.admissionBlockReason).toBe("WHATSAPP_RECIPIENT_SUPPRESSED");

      suppressionUntil = new Date(Date.now() - 1_000);
      const expiryWakeup = schedule.mock.calls[2]?.[0];
      expect(expiryWakeup?.trigger).not.toBe(updateWakeup?.trigger);
      await processor.resume("recovery-1", expiryWakeup!.trigger);
      expect(initiate).toHaveBeenCalledTimes(2);
      expect(initiate).toHaveBeenLastCalledWith(expect.any(Object), 1, currentRecipient, expiryWakeup!.trigger);
      expect(attempts).toBe(1);
      expect(charges).toBe(1);
      expect(sends).toBe(1);
      expect(current.status).toBe("DETECTED");
      expect(current.admissionBlockReason).toBeNull();
    }
  });

  it("uses the Shop-scoped stored phone when the fresh checkout has no customer phone", async () => {
    const harness = createHarness({
      reads: [suppressionBlockedRecovery, suppressionBlockedRecovery, { status: "MESSAGE_SENT", admissionBlockReason: null }],
      customerRecipient: "15558675309",
    });

    await harness.service.resume("recovery-1");

    expect(harness.recipientResolver.resolveForCustomerInShop).toHaveBeenCalledWith("customer-1", "shop-1");
    expect(harness.initiate).toHaveBeenCalledWith(expect.any(Object), 1, "15558675309", undefined);
  });

  it("passes later recovery generations to canonical initiation", async () => {
    const harness = createHarness({
      reads: [
        { ...blockedRecovery, generation: 3 },
        { ...blockedRecovery, generation: 3 },
        { status: "MESSAGE_SENT", admissionBlockReason: null },
      ],
    });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "initiated",
      status: "MESSAGE_SENT",
    });
    expect(harness.initiate.mock.calls[0]).toHaveLength(4);
    expect(harness.initiate.mock.calls[0][1]).toBe(3);
    expect(harness.initiate.mock.calls[0][2]).toBe("15551234567");
  });

  it("reports capacity exhaustion while the durable block remains and makes replay a no-op after it clears", async () => {
    const harness = createHarness({
      reads: [
        blockedRecovery,
        blockedRecovery,
        { status: "DETECTED", admissionBlockReason: "RECOVERY_CAPACITY_EXHAUSTED" },
        { ...blockedRecovery, status: "MESSAGE_SENT", admissionBlockReason: null },
      ],
    });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "capacity-exhausted",
    });
    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "ignored",
      reason: "not-capacity-blocked",
    });
    expect(harness.abandonedCheckoutLookupService.lookup).toHaveBeenCalledOnce();
    expect(harness.initiate).toHaveBeenCalledOnce();
  });
});