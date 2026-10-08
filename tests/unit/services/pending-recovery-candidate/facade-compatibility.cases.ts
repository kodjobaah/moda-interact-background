import { expect, it } from "vitest";
import type { CandidateFacadeContext } from "../pending-recovery-candidate.service.test.js";

/** Coordinator-level coverage; collaborator branch detail lives in the focused suites. */
export function registerCompatibilityCases(context: CandidateFacadeContext) {
  const { queueInstance, FakeJob, domainModule, serviceModule, redisZsets, redisMock, prismaMock } = context;

  it("reuses a legacy candidate ID during the rollout without duplicating work", async () => {
    const { createPendingRecoveryCandidateJobId } = await import(
      "@modainteract/moda-interact-shared/shopify/node"
    );
    const legacyJobId = createPendingRecoveryCandidateJobId("shop_1", "checkout_legacy");
    const legacyJob = new FakeJob({
      shopId: "shop_1",
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_legacy",
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
    });
    queueInstance.jobs.set(legacyJobId, legacyJob);

    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "SHOP.MYSHOPIFY.COM",
      checkoutToken: "checkout_legacy",
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,

    });

    expect(result.outcome).toBe("refreshed");
    expect(result.jobId).toBe(legacyJobId);
    expect(queueInstance.addCalls).toHaveLength(0);
    expect(legacyJob.updatedData?.shopDomain).toBe("shop.myshopify.com");
  });

  it.each(["delayed", "waiting", "active"])(
    "keeps a %s job in the shop index",
    async (state) => {
      const { createPendingRecoveryCandidateJobId } = await import(
        "@modainteract/moda-interact-shared/shopify/node"
      );
      const candidate = {
        shopId: "shop_1",
        shopDomain: "shop.myshopify.com",
        checkoutToken: `checkout-${state}`,
        cartToken: null,
        abandonedCheckoutUrl: null,
        checkoutCreatedAt: null,
      };
      const jobId = `shop_1--${createPendingRecoveryCandidateJobId("shop_1", candidate.checkoutToken)}`;
      const job = new FakeJob(candidate, state);
      job.id = jobId;
      queueInstance.jobs.set(jobId, job);

      const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
        shopDomain: candidate.shopDomain,
        checkoutToken: candidate.checkoutToken,
        cartToken: null,
        abandonedCheckoutUrl: null,
        checkoutCreatedAt: null,

      });

      expect(result.jobId).toBe(jobId);
      expect(redisZsets.get(domainModule.pendingCandidateShopIndexKey("shop_1"))?.has(jobId)).toBe(true);
    },
  );

  it("removes a retained failed job from the shop index without re-adding it", async () => {
    const { createPendingRecoveryCandidateJobId } = await import(
      "@modainteract/moda-interact-shared/shopify/node"
    );
    const candidate = {
      shopId: "shop_1",
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout-failed",
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
    };
    const jobId = `shop_1--${createPendingRecoveryCandidateJobId("shop_1", candidate.checkoutToken)}`;
    const job = new FakeJob(candidate, "failed");
    job.id = jobId;
    queueInstance.jobs.set(jobId, job);
    await redisMock.zadd(domainModule.pendingCandidateShopIndexKey("shop_1"), Date.now(), jobId);

    await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: candidate.shopDomain,
      checkoutToken: candidate.checkoutToken,
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,

    });

    expect(redisZsets.get(domainModule.pendingCandidateShopIndexKey("shop_1"))?.has(jobId) ?? false).toBe(false);
    expect(redisMock.zadd).toHaveBeenCalledTimes(1);
  });

  it("removes the stale legacy member when both job IDs exist", async () => {
    const { createPendingRecoveryCandidateJobId } = await import(
      "@modainteract/moda-interact-shared/shopify/node"
    );
    const legacyJobId = createPendingRecoveryCandidateJobId("shop_1", "checkout_both");
    const activeJobId = `shop_1--${legacyJobId}`;
    const candidate = {
      shopId: "shop_1",
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_both",
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
    };
    const legacyJob = new FakeJob(candidate);
    const activeJob = new FakeJob(candidate);
    activeJob.id = activeJobId;
    queueInstance.jobs.set(legacyJobId, legacyJob);
    queueInstance.jobs.set(activeJobId, activeJob);
    await redisMock.zadd(domainModule.pendingCandidateShopIndexKey("shop_1"), Date.now(), legacyJobId);
    await redisMock.zadd(domainModule.pendingCandidateShopIndexKey("shop_1"), Date.now(), activeJobId);

    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_both",
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,

    });

    expect(result.jobId).toBe(activeJobId);
    expect(legacyJob.removed).toBe(true);
    expect(redisZsets.get(domainModule.pendingCandidateShopIndexKey("shop_1"))).toEqual(
      new Map([[activeJobId, expect.any(Number)]]),
    );
  });

  it("provides O(1) checkout/cart lookup and cleans indexes on maturation", async () => {
    const result = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_1",
      cartToken: "cart_1",
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: "2026-08-28T00:00:00Z",

    });

    const checkoutJobId = await serviceModule.pendingRecoveryCandidateService.findCandidateJobIdByCheckout(
      {
        shopId: "shop_1",
        checkoutToken: "checkout_1",
      },
    );

    const cartJobId = await serviceModule.pendingRecoveryCandidateService.findCandidateJobIdByCart(
      {
        shopId: "shop_1",
        cartToken: "cart_1",
      },
    );

    expect(checkoutJobId).toBe(result.jobId);
    expect(cartJobId).toBe(result.jobId);

    await serviceModule.pendingRecoveryCandidateService.handleCandidateMatured(
      result.candidate,
      result.jobId,
    );

    expect(
      await serviceModule.pendingRecoveryCandidateService.findCandidateJobIdByCheckout({
        shopId: "shop_1",
        checkoutToken: "checkout_1",
      }),
    ).toBeNull();
    expect(redisZsets.has(domainModule.pendingCandidateShopIndexKey("shop_1"))).toBe(false);
  });

  it("keeps different shops in separate ordered indexes", async () => {
    prismaMock.shop.findUnique
      .mockResolvedValueOnce({ id: "shop_1", status: "ACTIVE", platform: "SHOPIFY", subscription: { status: "ACTIVE" }, settings: { recoveryDelayMinutes: 45 } })
      .mockResolvedValueOnce({ id: "shop_2", status: "ACTIVE", platform: "SHOPIFY", subscription: { status: "ACTIVE" }, settings: { recoveryDelayMinutes: 10 } });

    const first = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_1",
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,

    });
    const second = await serviceModule.pendingRecoveryCandidateService.scheduleFromCheckoutCreated({
      shopDomain: "shop.myshopify.com",
      checkoutToken: "checkout_2",
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,

    });

    expect(redisZsets.get(domainModule.pendingCandidateShopIndexKey("shop_1"))?.has(first.jobId)).toBe(true);
    expect(redisZsets.get(domainModule.pendingCandidateShopIndexKey("shop_1"))?.has(second.jobId)).toBe(false);
    expect(redisZsets.get(domainModule.pendingCandidateShopIndexKey("shop_2"))?.has(second.jobId)).toBe(true);
  });
}
