import { expect, it, vi } from "vitest";
import type { CandidateFacadeContext } from "../pending-recovery-candidate.service.test.js";

/** Coordinator-level coverage; collaborator branch detail lives in the focused suites. */
export function registerSchedulingCases(context: CandidateFacadeContext) {
  const { queueInstance, getQueueOptions, domainModule, serviceModule, recoveryPolicyMocks, prismaMock, redisZsets, redisMock } = context;

  it("schedules a delayed candidate using the effective recovery-policy delay", async () => {
    const before = Date.now();
    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_1",
      cartToken: "cart_1",
      abandonedCheckoutUrl: "https://shop.example/recover",
      checkoutCreatedAt: "2026-08-28T00:00:00Z",
    });

    expect(result.outcome).toBe("enqueued");
    expect(result.delayMinutes).toBe(45);
    expect(recoveryPolicyMocks.resolve).toHaveBeenCalledWith("shop_1");
    expect(queueInstance.addCalls).toHaveLength(1);
    expect(queueInstance.addCalls[0].opts.delay).toBe(45 * 60 * 1000);
    expect(queueInstance.addCalls[0].data).toBe(result.candidate);
    const shopIndex = redisZsets.get(
      domainModule.pendingCandidateShopIndexKey("shop_1"),
    );
    expect(shopIndex?.get(result.jobId)).toBeGreaterThanOrEqual(
      before + 45 * 60 * 1000,
    );
    expect(getQueueOptions()).toMatchObject({
      telemetry: expect.any(Object),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 1_000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });
    expect(result.candidate).toEqual(expect.objectContaining({
      shopId: "shop_1",
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_1",
      cartToken: "cart_1",
      abandonedCheckoutUrl: "https://shop.example/recover",
      checkoutCreatedAt: "2026-08-28T00:00:00Z",
      lastActivityAt: expect.any(String),
    }));
  });

  it("uses an active Admin override delay for initial scheduling", async () => {
    recoveryPolicyMocks.resolve.mockResolvedValueOnce({
      recoveryDelayMinutes: 120,
      recoveryOfferMode: "NONE",
      fixedShopifyDiscountId: null,
      followUpEnabled: false,
      followUpDelayMinutes: null,
      source: "ADMIN_OVERRIDE",
      offerSnapshot: null,
    });

    const lastActivityAt = "2026-12-28T00:00:00.000Z";
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse(lastActivityAt));
    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_admin_override",
      cartToken: "cart_admin_override",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
      activityAt: lastActivityAt,
    });
    nowSpy.mockRestore();

    expect(result.outcome).toBe("enqueued");
    expect(result.delayMinutes).toBe(120);
    expect(queueInstance.addCalls[0].opts.delay).toBe(120 * 60 * 1000);
    expect(redisZsets.get(domainModule.pendingCandidateShopIndexKey("shop_1"))?.get(result.jobId)).toBe(
      Date.parse(lastActivityAt) + 120 * 60 * 1000,
    );
  });

  it.each(["UNINSTALLED", "SUSPENDED"] as const)(
    "does not enqueue or index a %s shop candidate",
    async (status) => {
      prismaMock.shop.findUnique.mockResolvedValueOnce({
        id: "shop_1",
        status,
        settings: { recoveryDelayMinutes: 45 },
      });

      const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
        shopDomain: "shop.myshopify.com",
        checkoutToken: `checkout_${status.toLowerCase()}`,
        cartToken: "cart_1",
        abandonedCheckoutUrl: null,
        checkoutCreatedAt: "2026-08-28T00:00:00Z",
      });

      expect(result).toEqual({
        outcome: "discarded-shop-unavailable",
        shopDomain: "shop.myshopify.com",
      });
      expect(queueInstance.addCalls).toHaveLength(0);
      expect(redisZsets.size).toBe(0);
    },
  );

  it("discards a frozen checkout before queue or Redis candidate work", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_1",
      status: "ACTIVE",
      platform: "SHOPIFY",
      subscription: { status: "FROZEN" },
      settings: { recoveryDelayMinutes: 45 },
    });

    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_frozen",
      cartToken: "cart_frozen",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: "2026-08-28T00:00:00Z",
    });

    expect(result).toEqual({
      outcome: "discarded-subscription-frozen",
      shopDomain: "shop.myshopify.com",
    });
    expect(queueInstance.addCalls).toHaveLength(0);
    expect(redisMock.set).not.toHaveBeenCalled();
    expect(redisMock.zadd).not.toHaveBeenCalled();
  });

  it("schedules a Woo frozen checkout into recovery candidate processing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_1",
      status: "ACTIVE",
      platform: "WOOCOMMERCE",
      subscription: { status: "FROZEN" },
      settings: { recoveryDelayMinutes: 45 },
    });

    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_woo_frozen",
      cartToken: "cart_woo_frozen",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: "2026-08-28T00:00:00Z",
    });

    expect(result.outcome).toBe("enqueued");
    expect(queueInstance.addCalls).toHaveLength(1);
  });

  it("refreshes a Woo frozen candidate from checkout updates", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_1",
      status: "ACTIVE",
      platform: "WOOCOMMERCE",
      subscription: { status: "FROZEN" },
      settings: { recoveryDelayMinutes: 45 },
    });

    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutUpdated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_woo_update",
      cartToken: "cart_woo_update",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: "2026-08-28T00:00:00Z",
      activityAt: "2026-08-28T00:15:00Z",
    });

    expect(result.outcome).toBe("enqueued");
    expect(queueInstance.addCalls).toHaveLength(1);
  });

  it("refreshes an existing delayed candidate idempotently", async () => {
    await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_1",
      cartToken: "cart_1",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: "2026-08-28T00:00:00Z",
    });

    const shopIndexKey = domainModule.pendingCandidateShopIndexKey("shop_1");
    const firstJobId = [...(redisZsets.get(shopIndexKey)?.keys() ?? [])][0] ?? null;
    const firstScore = redisZsets.get(shopIndexKey)?.get(firstJobId!);
    const refreshedAt = Date.now() + 60_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(refreshedAt);
    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_1",
      cartToken: "cart_2",
      abandonedCheckoutUrl: "https://shop.example/recover-2",
      checkoutCreatedAt: "2026-08-28T00:01:00Z",
    });
    nowSpy.mockRestore();

    expect(result.outcome).toBe("refreshed");
    expect(queueInstance.addCalls).toHaveLength(1);
    expect(queueInstance.addCalls[0].opts.jobId).toMatch(/^shop_1--pending-recovery-/);

    const job = queueInstance.jobs.get(result.jobId);
    expect(job?.updatedData?.cartToken).toBe("cart_2");
    expect(job?.delayChanges).toEqual([45 * 60 * 1000]);
    expect(firstJobId).toBe(result.jobId);
    expect(redisZsets.get(shopIndexKey)?.get(result.jobId)).toBe(
      refreshedAt + 45 * 60 * 1000,
    );
    expect(redisZsets.get(shopIndexKey)?.get(result.jobId)).toBeGreaterThan(firstScore!);
  });

  it.each(["active", "waiting"] as const)(
    "preserves one delayed successor through %s completion cleanup and duplicate updates",
    async (state) => {
    const original = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_active_handoff",
      cartToken: null,
      abandonedCheckoutUrl: "https://shop.example/recover",
      checkoutCreatedAt: "2026-08-28T00:00:00.000Z",
      activityAt: "2026-08-28T00:00:00.000Z",
    });
    const activeJob = queueInstance.jobs.get(original.jobId)!;
    activeJob.state = state;
    const update = {
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_active_handoff",
      activityAt: "2026-08-28T01:00:00.000Z",
    };

    const first = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutUpdated(update);
    const duplicate = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutUpdated(update);

    expect(first.outcome).toBe("enqueued");
    expect(duplicate.outcome).toBe("refreshed");
    expect(duplicate.jobId).toBe(first.jobId);
    expect(queueInstance.addCalls).toHaveLength(2);

    queueInstance.jobs.delete(original.jobId);
    await serviceModule.pendingRecoveryCandidateService.handleCandidateMatured(
      original.candidate,
      original.jobId,
    );

    expect(await serviceModule.pendingRecoveryCandidateService.findCandidateJobIdByCheckout({
      shopId: "shop_1",
      checkoutToken: "checkout_active_handoff",
    })).toBe(first.jobId);
    expect(queueInstance.jobs.get(first.jobId)?.state).toBe("delayed");
    expect(queueInstance.jobs.get(first.jobId)?.data).toMatchObject({
      checkoutToken: "checkout_active_handoff",
      abandonedCheckoutUrl: "https://shop.example/recover",
      checkoutCreatedAt: "2026-08-28T00:00:00.000Z",
    });
    },
  );

  it("serializes duplicate updates behind cleanup when removeOnComplete already removed the active job", async () => {
    const original = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_cleanup_handoff",
      cartToken: null,
      abandonedCheckoutUrl: "https://shop.example/recover",
      checkoutCreatedAt: "2026-08-28T00:00:00.000Z",
      activityAt: "2026-08-28T00:00:00.000Z",
    });
    const originalJob = queueInstance.jobs.get(original.jobId)!;
    originalJob.state = "active";
    const checkoutIndexKey = domainModule.pendingCandidateCheckoutIndexKey({
      shopId: "shop_1",
      checkoutToken: "checkout_cleanup_handoff",
    });
    let signalCleanupRead!: () => void;
    let unblockCleanup!: () => void;
    const getStoredValue = redisMock.get.getMockImplementation()!;
    const cleanupReadReached = new Promise<void>((resolve) => { signalCleanupRead = resolve; });
    const cleanupGate = new Promise<void>((resolve) => { unblockCleanup = resolve; });
    redisMock.get.mockImplementationOnce(async (key: string) => {
      if (key === checkoutIndexKey) {
        signalCleanupRead();
        await cleanupGate;
      }
      return getStoredValue(key);
    });

    const cleanup = serviceModule.pendingRecoveryCandidateService.handleCandidateMatured(
      original.candidate,
      original.jobId,
    );
    await cleanupReadReached;
    queueInstance.jobs.delete(original.jobId);
    const update = {
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_cleanup_handoff",
      activityAt: "2026-08-28T01:00:00.000Z",
    };
    const firstUpdate = serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutUpdated(update);
    const duplicateUpdate = serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutUpdated(update);
    unblockCleanup();
    await cleanup;
    const [first, duplicate] = await Promise.all([firstUpdate, duplicateUpdate]);

    expect(first.outcome).toBe("enqueued");
    expect(duplicate.outcome).toBe("refreshed");
    expect(duplicate.jobId).toBe(first.jobId);
    expect(queueInstance.addCalls).toHaveLength(2);
    expect(await serviceModule.pendingRecoveryCandidateService.findCandidateJobIdByCheckout({
      shopId: "shop_1",
      checkoutToken: "checkout_cleanup_handoff",
    })).toBe(first.jobId);
  });

  it("suppresses checkout-update re-entry after the order-completed tombstone", async () => {
    await redisMock.set(
      domainModule.checkoutOrderCompletedKey({
        shopId: "shop_1",
        checkoutToken: "checkout_ordered",
      }),
      "1",
    );

    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutUpdated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_ordered",
      activityAt: "2026-08-28T01:00:00.000Z",
    });

    expect(result.outcome).toBe("discarded-order-completed");
    expect(queueInstance.addCalls).toHaveLength(0);
    expect(redisZsets.size).toBe(0);
  });

  it("removes the old cart alias when checkout scheduling changes cart token", async () => {
    const first = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_cart_change",
      cartToken: "cart_old",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
      activityAt: "2026-08-28T00:00:00.000Z",

    });

    const second = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_cart_change",
      cartToken: "cart_new",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
      activityAt: "2026-08-28T01:00:00.000Z",

    });

    expect(second.jobId).toBe(first.jobId);
    expect(await serviceModule.pendingRecoveryCandidateService.findCandidateJobIdByCart({
      shopId: "shop_1",
      cartToken: "cart_old",
    })).toBeNull();
    expect(await serviceModule.pendingRecoveryCandidateService.findCandidateJobIdByCart({
      shopId: "shop_1",
      cartToken: "cart_new",
    })).toBe(first.jobId);
    expect(queueInstance.jobs.get(first.jobId)?.data.cartToken).toBe("cart_new");
  });

  it("does not move an existing candidate backwards on an older checkout event", async () => {
    const first = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_monotonic",
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
      activityAt: "2026-08-28T02:00:00.000Z",

    });
    const job = queueInstance.jobs.get(first.jobId)!;

    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_monotonic",
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
      activityAt: "2026-08-28T01:00:00.000Z",

    });

    expect(result.candidate.lastActivityAt).toBe("2026-08-28T02:00:00.000Z");
    expect(job.updatedData?.lastActivityAt).toBe("2026-08-28T02:00:00.000Z");
  });
}
