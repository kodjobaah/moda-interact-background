import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecoveryCapacityResumeProcessorService } from "../../../../src/services/checkout-recovery/recovery-capacity-resume-processor.service.js";
import { RecoveryRecipientSuppressionAdmissionService } from "../../../../src/services/checkout-recovery/recovery-recipient-suppression-admission.service.js";
import { CheckoutEventOrchestratorService } from "../../../../src/services/checkout-recovery/checkout-event-orchestrator.service.js";
import { CheckoutOrderGuardService } from "../../../../src/services/pending-recovery-candidate/checkout-order-guard.service.js";
import type { RecoveryCapacityResumeJob } from "../../../../src/domain/recovery-capacity-resume.js";

const schedule = vi.hoisted(() => vi.fn(async (_job: RecoveryCapacityResumeJob, _dueAt?: Date) => "job-id"));
const lockRedis = vi.hoisted(() => {
  const values = new Map<string, { value: string; expiresAt: number | null }>();
  const liveValue = (key: string) => {
    const entry = values.get(key);
    if (entry?.expiresAt !== null && entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      values.delete(key);
      return null;
    }
    return entry ?? null;
  };
  return {
    values,
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      const existing = liveValue(key);
      if (args.includes("NX") && existing) return null;
      const pxIndex = args.indexOf("PX");
      values.set(key, {
        value,
        expiresAt: pxIndex >= 0 ? Date.now() + Number(args[pxIndex + 1]) : null,
      });
      return "OK";
    }),
    get: vi.fn(async (key: string) => liveValue(key)?.value ?? null),
    del: vi.fn(async (key: string) => values.delete(key) ? 1 : 0),
  };
});
vi.mock("../../../../src/lib/redis.js", () => ({ connectionRedis: lockRedis }));
vi.mock("../../../../src/services/recovery-capacity-resume.service.js", () => ({
  recoveryCapacityResumeService: { schedule },
}));

type RecoveryRecord = {
  id: string;
  shopId: string;
  checkoutToken: string;
  cartToken: string | null;
  checkoutUrl: string | null;
  detectedAt: Date;
  lastExternalActivityAt: Date;
  generation: number;
  status: string;
  admissionBlockReason: string | null;
  updatedAt: Date;
  customerId: string | null;
  shop: { domain: string; status: string };
};

const blockedRecovery: RecoveryRecord = {
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

const currentCheckout: {
  createdAt: string;
  completedAt: string | null;
  currencyCode: string;
  totalPrice: string;
  abandonedCheckoutUrl: string;
  customer: null;
  lineItems: never[];
  internationalContext: null;
} = {
  createdAt: "2026-09-01T00:00:00.000Z",
  completedAt: null,
  currencyCode: "GBP",
  totalPrice: "42.00",
  abandonedCheckoutUrl: "https://checkout/current",
  customer: null,
  lineItems: [],
  internationalContext: null,
};

type CheckoutLookup =
  | { kind: "found"; checkout: typeof currentCheckout }
  | { kind: "not-found" }
  | { kind: "provider-error"; message: string }
  | { kind: "ambiguous" }
  | { kind: "bounded-limit-exceeded" };

type RecoveryResumeHarnessOptions = {
  reads?: unknown[];
  lookup?: CheckoutLookup;
  allowed?: boolean;
  updateCount?: number;
  resolvedRecipient?: string | null;
  customerRecipient?: string | null;
  recoveryDelayMinutes?: number;
  now?: () => Date;
  checkoutLock?: Pick<CheckoutOrderGuardService, "withCheckoutLock">;
};

function createHarness({
  reads = [blockedRecovery, blockedRecovery, blockedRecovery, { status: "MESSAGE_SENT", admissionBlockReason: null }],
  lookup = { kind: "found", checkout: currentCheckout },
  allowed = true,
  updateCount = 1,
  resolvedRecipient = null,
  customerRecipient = "15551234567",
  recoveryDelayMinutes = 30,
  now = () => new Date(),
  checkoutLock,
}: RecoveryResumeHarnessOptions = {}) {
  const order: string[] = [];
  const readResults = [...reads];
  let checkoutLockHeld = false;
  const database = {
    checkoutRecovery: {
      findUnique: vi.fn(async (): Promise<unknown> => {
        order.push("recovery-read");
        return (readResults.length > 1 ? readResults.shift() : readResults[0]) ?? null;
      }),
      updateMany: vi.fn(async ({ data }: { data: Partial<RecoveryRecord> }) => {
        order.push("activity-write");
        const current = readResults.find((record) =>
          record && typeof record === "object" && "id" in record && record.id === "recovery-1",
        ) as RecoveryRecord | undefined;
        if (current) Object.assign(current, data);
        return { count: current ? 1 : 0 };
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
  const lockService = checkoutLock ?? {
    withCheckoutLock: async (
      _shopId: string,
      _checkoutToken: string,
      callback: () => Promise<unknown>,
    ) => callback(),
  };
  const pendingRecoveryCandidateService = {
    withCheckoutLock: vi.fn(async (
      _shopId: string,
      _checkoutToken: string,
      callback: () => Promise<unknown>,
    ) => {
      order.push("lock");
      checkoutLockHeld = true;
      try {
        return await lockService.withCheckoutLock(_shopId, _checkoutToken, callback);
      } finally {
        checkoutLockHeld = false;
      }
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
  const initiate = vi.fn(async (
    _seed: unknown,
    _generation?: number,
    _recipient?: string,
    _wakeupTrigger?: string,
    _admissionGate?: () => Promise<boolean>,
  ) => undefined);
  const recipientResolver = {
    resolve: vi.fn(async () => resolvedRecipient),
    resolveForCustomerInShop: vi.fn(async () => customerRecipient),
  };
  const suppressionAdmission = {
    clearDetectedSuppression: vi.fn(async () => undefined),
  };
  const recoveryPolicyResolver = {
    resolve: vi.fn(async () => ({ recoveryDelayMinutes })),
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
    recoveryPolicyResolver as never,
    now,
  );

  return {
    order,
    readResults,
    isCheckoutLockHeld: () => checkoutLockHeld,
    database,
    pendingRecoveryCandidateService,
    shopExecutionEligibilityService,
    abandonedCheckoutLookupService,
    snapshotBuilder,
    initiate,
    recipientResolver,
    suppressionAdmission,
    service,
    recoveryPolicyResolver,
  };
}

describe("RecoveryCapacityResumeProcessorService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lockRedis.values.clear();
    vi.useRealTimers();
  });

  afterEach(() => vi.useRealTimers());

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

  it("schedules a distinct successor when policy extends an active maturity job", async () => {
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
    expect(maturityJob).toMatchObject({
      shopId: "shop-1",
      recoveryId: "recovery-1",
    });
    expect(maturityJob?.trigger).toMatch(
      new RegExp(`^recipient-suppression-recovery-1-maturity-${latestActivity.getTime()}-after-`),
    );
    expect(maturityJob?.trigger).not.toBe(staleTrigger);
    expect(schedule.mock.calls[0]?.[1]).toEqual(new Date(latestActivity.getTime() + 30 * 60_000));
    expect(harness.abandonedCheckoutLookupService.lookup).not.toHaveBeenCalled();
    expect(harness.initiate).not.toHaveBeenCalled();

    now = new Date(latestActivity.getTime() + 30 * 60_000);
    harness.recoveryPolicyResolver.resolve
      .mockResolvedValueOnce({ recoveryDelayMinutes: 60 });
    await expect(harness.service.resume("recovery-1", maturityJob!.trigger)).resolves.toEqual({
      kind: "deferred-activity",
      dueAt: new Date(latestActivity.getTime() + 60 * 60_000),
    });
    const extendedMaturityJob = schedule.mock.calls[1]?.[0];
    expect(extendedMaturityJob?.trigger).not.toBe(maturityJob?.trigger);
    expect(schedule.mock.calls[1]?.[1]).toEqual(new Date(latestActivity.getTime() + 60 * 60_000));
    expect(harness.initiate).not.toHaveBeenCalled();

    now = new Date(latestActivity.getTime() + 60 * 60_000);
    await harness.service.resume("recovery-1", extendedMaturityJob!.trigger);
    expect(harness.abandonedCheckoutLookupService.lookup).toHaveBeenCalledOnce();
    expect(harness.initiate).toHaveBeenCalledOnce();

    await expect(harness.service.resume("recovery-1", extendedMaturityJob!.trigger)).resolves.toMatchObject({
      kind: "ignored",
    });
    expect(harness.initiate).toHaveBeenCalledOnce();
  });

  it("defers admission when checkout activity commits during the unlocked Shopify lookup", async () => {
    schedule.mockClear();
    const initialActivity = new Date("2026-10-11T20:00:00.000Z");
    const newerActivity = new Date("2026-10-11T20:30:00.000Z");
    let now = new Date("2026-10-11T20:30:00.000Z");
    const current = {
      ...suppressionBlockedRecovery,
      lastExternalActivityAt: initialActivity,
    };
    let lockTail = Promise.resolve();
    const withCheckoutLock = vi.fn(async (
      _shopId: string,
      _checkoutToken: string,
      callback: () => Promise<unknown>,
    ) => {
      const previous = lockTail;
      let release!: () => void;
      lockTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await callback();
      } finally {
        release();
      }
    });
    const database = {
      checkoutRecovery: {
        findUnique: vi.fn(async ({ select }: { select?: Record<string, unknown> }) =>
          select?.status && select?.admissionBlockReason && Object.keys(select).length === 2
            ? { status: current.status, admissionBlockReason: current.admissionBlockReason }
            : { ...current, shop: blockedRecovery.shop },
        ),
        updateMany: vi.fn(async ({ data }: { data: { lastExternalActivityAt: Date } }) => {
          current.lastExternalActivityAt = data.lastExternalActivityAt;
          return { count: 1 };
        }),
      },
    };
    let releaseLookup!: () => void;
    let signalLookupStarted!: () => void;
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const lookupStarted = new Promise<void>((resolve) => { signalLookupStarted = resolve; });
    let lookupCount = 0;
    const lookup = vi.fn(async () => {
      lookupCount += 1;
      if (lookupCount === 1) {
        signalLookupStarted();
        await lookupGate;
      }
      return { kind: "found" as const, checkout: currentCheckout };
    });
    let admissions = 0;
    const initiate = vi.fn(async () => {
      admissions += 1;
      current.status = "MESSAGE_SENT";
      current.admissionBlockReason = null;
    });
    const processor = new RecoveryCapacityResumeProcessorService(
      database as never,
      { withCheckoutLock } as never,
      { evaluate: vi.fn(async () => ({ allowed: true, shopId: "shop-1" })) } as never,
      { lookup } as never,
      { build: vi.fn(async () => ({ shop: "shop.example", checkoutToken: "checkout-1" })) } as never,
      initiate,
      {
        resolve: vi.fn(async () => "15551234567"),
        resolveForCustomerInShop: vi.fn(async () => null),
      } as never,
      { clearDetectedSuppression: vi.fn(async () => undefined) } as never,
      { schedule } as never,
      { resolve: vi.fn(async () => ({ recoveryDelayMinutes: 30 })) } as never,
      () => now,
    );
    const activityWriter = new CheckoutEventOrchestratorService(
      database as never,
      { withCheckoutLock } as never,
      {} as never,
      vi.fn() as never,
      {} as never,
      {} as never,
    );
    const trigger = `recipient-suppression-recovery-1-checkout-update-${initialActivity.getTime()}`;

    const inFlightResume = processor.resume("recovery-1", trigger);
    await lookupStarted;
    await activityWriter.recordExternalActivity("recovery-1", newerActivity, {
      shopId: "shop-1",
      checkoutToken: "checkout-1",
    });
    expect(current.lastExternalActivityAt).toEqual(newerActivity);
    releaseLookup();

    await expect(inFlightResume).resolves.toEqual({
      kind: "deferred-activity",
      dueAt: new Date(newerActivity.getTime() + 30 * 60_000),
    });
    const maturityJob = schedule.mock.calls[0]?.[0];
    expect(schedule.mock.calls[0]?.[1]).toEqual(new Date(newerActivity.getTime() + 30 * 60_000));
    expect(admissions).toBe(0);
    expect(initiate).not.toHaveBeenCalled();

    now = new Date(newerActivity.getTime() + 30 * 60_000);
    await processor.resume("recovery-1", maturityJob!.trigger);
    expect(admissions).toBe(1);
    expect(initiate).toHaveBeenCalledOnce();
    await expect(processor.resume("recovery-1", maturityJob!.trigger)).resolves.toMatchObject({
      kind: "ignored",
    });
    expect(admissions).toBe(1);
  });

  it("rechecks activity after slow initiation prep and releases the checkout lock beyond its lease window", async () => {
    vi.useFakeTimers();
    schedule.mockClear();
    const initialActivity = new Date("2026-10-11T20:00:00.000Z");
    const current = {
      ...suppressionBlockedRecovery,
      lastExternalActivityAt: initialActivity,
    };
    let now = new Date(initialActivity.getTime() + 30 * 60_000);
    vi.setSystemTime(now);
    const checkoutLock = new CheckoutOrderGuardService();
    const harness = createHarness({
      reads: [current, current, current, current, current, current, current, current, {
        status: "MESSAGE_SENT",
        admissionBlockReason: null,
      }],
      now: () => now,
      recoveryDelayMinutes: 30,
      checkoutLock,
    });
    let releasePreparation!: () => void;
    let signalPreparationStarted!: () => void;
    const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const preparationStarted = new Promise<void>((resolve) => { signalPreparationStarted = resolve; });
    let initiationCount = 0;
    let billableAdmissions = 0;
    let providerSends = 0;
    harness.initiate.mockImplementation(async (_seed, _generation, _recipient, _trigger, admissionGate) => {
      initiationCount += 1;
      if (initiationCount === 1) {
        signalPreparationStarted();
        await preparationGate;
      }
      if (admissionGate && await admissionGate()) {
        billableAdmissions += 1;
        providerSends += 1;
        current.status = "MESSAGE_SENT";
        current.admissionBlockReason = null;
      }
    });
    const activityWriter = new CheckoutEventOrchestratorService(
      harness.database as never,
      harness.pendingRecoveryCandidateService as never,
      {} as never,
      vi.fn() as never,
      {} as never,
      {} as never,
    );
    const trigger = `recipient-suppression-recovery-1-checkout-update-${initialActivity.getTime()}`;
    const inFlightResume = harness.service.resume("recovery-1", trigger);
    await preparationStarted;

    expect(harness.isCheckoutLockHeld()).toBe(false);
    let newerActivity = new Date(Date.now() + 1);
    now = newerActivity;
    let lockCalls = lockRedis.set.mock.calls.length;
    await activityWriter.recordExternalActivity("recovery-1", newerActivity, {
      shopId: "shop-1",
      checkoutToken: "checkout-1",
    });
    expect(lockRedis.set).toHaveBeenCalledTimes(lockCalls + 1);
    expect(current.lastExternalActivityAt).toEqual(newerActivity);
    expect(harness.isCheckoutLockHeld()).toBe(false);

    await vi.advanceTimersByTimeAsync(10_001);
    newerActivity = new Date(Date.now());
    now = newerActivity;
    lockCalls = lockRedis.set.mock.calls.length;
    await activityWriter.recordExternalActivity("recovery-1", newerActivity, {
      shopId: "shop-1",
      checkoutToken: "checkout-1",
    });
    expect(lockRedis.set).toHaveBeenCalledTimes(lockCalls + 1);
    expect(current.lastExternalActivityAt).toEqual(newerActivity);

    releasePreparation();
    const firstResult = await inFlightResume;
    const dueAt = new Date(newerActivity.getTime() + 30 * 60_000);
    expect(firstResult).toEqual({ kind: "deferred-activity", dueAt });
    expect(schedule.mock.calls.at(-1)?.[1]).toEqual(dueAt);
    expect(billableAdmissions).toBe(0);
    expect(providerSends).toBe(0);

    now = dueAt;
    vi.setSystemTime(dueAt);
    const maturityJob = schedule.mock.calls.at(-1)?.[0];
    await expect(harness.service.resume("recovery-1", maturityJob?.trigger)).resolves.toEqual({
      kind: "initiated",
      status: "MESSAGE_SENT",
    });
    expect(billableAdmissions).toBe(1);
    expect(providerSends).toBe(1);

    harness.readResults.push(current);
    await expect(harness.service.resume("recovery-1", maturityJob?.trigger)).resolves.toMatchObject({
      kind: "ignored",
    });
    expect(billableAdmissions).toBe(1);
    expect(providerSends).toBe(1);
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
      "lock",
      "recovery-read",
      "eligibility",
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
      reads: [blockedRecovery, blockedRecovery, blockedRecovery, null],
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
    expect(harness.initiate).toHaveBeenCalledWith(
      expect.any(Object),
      1,
      "15551234567",
      undefined,
      expect.any(Function),
    );
  });

  it("re-evaluates a suppression-blocked recovery from fresh checkout state under its lock", async () => {
    const harness = createHarness({
      reads: [
        suppressionBlockedRecovery,
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
      "lock",
      "recovery-read",
      "eligibility",
      "recovery-read",
    ]);
    expect(harness.snapshotBuilder.build).toHaveBeenCalledOnce();
    expect(harness.initiate).toHaveBeenCalledOnce();
    expect(harness.initiate.mock.calls[0][2]).toBe("15551234567");
  });

  it("uses a changed current number as an independent recipient key", async () => {
    const harness = createHarness({
      reads: [suppressionBlockedRecovery, suppressionBlockedRecovery, suppressionBlockedRecovery, { status: "MESSAGE_SENT", admissionBlockReason: null }],
      resolvedRecipient: "447700900123",
    });

    await harness.service.resume("recovery-1");

    expect(harness.recipientResolver.resolveForCustomerInShop).not.toHaveBeenCalled();
    expect(harness.initiate).toHaveBeenCalledWith(
      expect.any(Object),
      1,
      "447700900123",
      undefined,
      expect.any(Function),
    );
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
      { ...suppressionBlockedRecovery, admissionBlockReason: "WHATSAPP_RECIPIENT_SUPPRESSED" },
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
      _generation: number | undefined,
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
    let currentRecipient: string | null = recipient;
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
      _generation: number | undefined,
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
        {
          refreshCandidateActivity: vi.fn(async () => ({ outcome: "not-found" })),
          withCheckoutLock: async (_shopId: string, _checkoutToken: string, callback: () => Promise<unknown>) => callback(),
        } as never,
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
      expect(initiate).toHaveBeenCalledWith(
        expect.any(Object),
        1,
        currentRecipient,
        updateWakeup!.trigger,
        expect.any(Function),
      );
      expect(attempts).toBe(0);
      expect(charges).toBe(0);
      expect(sends).toBe(0);
      expect(current.admissionBlockReason).toBe("WHATSAPP_RECIPIENT_SUPPRESSED");

      suppressionUntil = new Date(Date.now() - 1_000);
      const expiryWakeup = schedule.mock.calls[2]?.[0];
      expect(expiryWakeup?.trigger).not.toBe(updateWakeup?.trigger);
      await processor.resume("recovery-1", expiryWakeup!.trigger);
      expect(initiate).toHaveBeenCalledTimes(2);
      expect(initiate).toHaveBeenLastCalledWith(
        expect.any(Object),
        1,
        currentRecipient,
        expiryWakeup!.trigger,
        expect.any(Function),
      );
      expect(attempts).toBe(1);
      expect(charges).toBe(1);
      expect(sends).toBe(1);
      expect(current.status).toBe("DETECTED");
      expect(current.admissionBlockReason).toBeNull();
    }
  });

  it("uses the Shop-scoped stored phone when the fresh checkout has no customer phone", async () => {
    const harness = createHarness({
      reads: [suppressionBlockedRecovery, suppressionBlockedRecovery, suppressionBlockedRecovery, { status: "MESSAGE_SENT", admissionBlockReason: null }],
      customerRecipient: "15558675309",
    });

    await harness.service.resume("recovery-1");

    expect(harness.recipientResolver.resolveForCustomerInShop).toHaveBeenCalledWith("customer-1", "shop-1");
    expect(harness.initiate).toHaveBeenCalledWith(
      expect.any(Object),
      1,
      "15558675309",
      undefined,
      expect.any(Function),
    );
  });

  it("passes later recovery generations to canonical initiation", async () => {
    const harness = createHarness({
      reads: [
        { ...blockedRecovery, generation: 3 },
        { ...blockedRecovery, generation: 3 },
        { ...blockedRecovery, generation: 3 },
        { status: "MESSAGE_SENT", admissionBlockReason: null },
      ],
    });

    await expect(harness.service.resume("recovery-1")).resolves.toEqual({
      kind: "initiated",
      status: "MESSAGE_SENT",
    });
    expect(harness.initiate.mock.calls[0]).toHaveLength(5);
    expect(harness.initiate.mock.calls[0][1]).toBe(3);
    expect(harness.initiate.mock.calls[0][2]).toBe("15551234567");
  });

  it("reports capacity exhaustion while the durable block remains and makes replay a no-op after it clears", async () => {
    const harness = createHarness({
      reads: [
        blockedRecovery,
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