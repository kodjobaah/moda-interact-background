import { describe, expect, it, vi } from "vitest";

import type { PendingRecoveryCandidate } from "../../../../src/domain/pending-recovery-candidate.js";
import {
  PendingRecoveryCandidateLifecycleService,
} from "../../../../src/services/pending-recovery-candidate/candidate-lifecycle.service.js";

function candidate(overrides: Partial<PendingRecoveryCandidate> = {}): PendingRecoveryCandidate {
  return {
    shopId: "shop-1",
    shopDomain: "shop.example",
    checkoutToken: "checkout-1",
    cartToken: "cart-1",
    abandonedCheckoutUrl: null,
    checkoutCreatedAt: "2026-10-08T08:00:00.000Z",
    lastActivityAt: "2026-10-08T08:00:00.000Z",
    ...overrides,
  };
}

function createHarness() {
  const jobs = new Map<string, {
    data: PendingRecoveryCandidate;
    state: string;
    remove: ReturnType<typeof vi.fn>;
  }>();
  const checkoutIds = new Map<string, string>();
  const cartIds = new Map<string, string>();
  const removeIndex = vi.fn(async () => undefined);
  const withCheckoutLock = vi.fn(async (_shopId: string, _checkoutToken: string, callback: () => Promise<unknown>) => callback());
  const indexStore = {
    findByCheckout: vi.fn(async ({ checkoutToken }: { shopId: string; checkoutToken: string }) => checkoutIds.get(checkoutToken) ?? null),
    findByCart: vi.fn(async ({ cartToken }: { shopId: string; cartToken: string }) => cartIds.get(cartToken) ?? null),
    remove: removeIndex,
  };
  const queue = {
    getJob: vi.fn(async (jobId: string) => {
      const job = jobs.get(jobId);
      if (!job) return null;
      return {
        data: job.data,
        getState: async () => job.state,
        remove: job.remove,
      };
    }),
  };
  const service = new PendingRecoveryCandidateLifecycleService({
    getQueue: () => queue,
    candidateIndexStore: indexStore,
    withCheckoutLock,
  });

  return {
    service,
    jobs,
    checkoutIds,
    cartIds,
    indexStore,
    queue,
    removeIndex,
    withCheckoutLock,
  };
}

describe("PendingRecoveryCandidateLifecycleService", () => {
  it("resolves by checkout index before considering the cart fallback", async () => {
    const harness = createHarness();
    const checkoutCandidate = candidate();
    harness.checkoutIds.set("checkout-1", "job-checkout");
    harness.cartIds.set("cart-1", "job-cart");
    harness.jobs.set("job-checkout", {
      data: checkoutCandidate,
      state: "delayed",
      remove: vi.fn(async () => undefined),
    });

    await expect(harness.service.resolve({
      shopId: "shop-1",
      checkoutToken: "checkout-1",
      cartToken: "cart-1",
    })).resolves.toEqual({ jobId: "job-checkout", candidate: checkoutCandidate });
    expect(harness.indexStore.findByCart).not.toHaveBeenCalled();
  });

  it("falls back to the cart index only when the checkout index has no job ID", async () => {
    const harness = createHarness();
    const cartCandidate = candidate({ checkoutToken: "checkout-cart" });
    harness.cartIds.set("cart-1", "job-cart");
    harness.jobs.set("job-cart", {
      data: cartCandidate,
      state: "delayed",
      remove: vi.fn(async () => undefined),
    });

    await expect(harness.service.resolve({
      shopId: "shop-1",
      checkoutToken: "checkout-1",
      cartToken: "cart-1",
    })).resolves.toEqual({ jobId: "job-cart", candidate: cartCandidate });
  });

  it("does not switch to cart correlation when the checkout index points at a missing job", async () => {
    const harness = createHarness();
    harness.checkoutIds.set("checkout-1", "missing-job");
    harness.cartIds.set("cart-1", "job-cart");
    harness.jobs.set("job-cart", {
      data: candidate(),
      state: "delayed",
      remove: vi.fn(async () => undefined),
    });

    await expect(harness.service.resolve({
      shopId: "shop-1",
      checkoutToken: "checkout-1",
      cartToken: "cart-1",
    })).resolves.toBeNull();
    expect(harness.indexStore.findByCart).not.toHaveBeenCalled();
  });

  it("cancels a resolved candidate and removes its queue job and indexes", async () => {
    const harness = createHarness();
    const stored = candidate();
    const removeJob = vi.fn(async () => undefined);
    harness.jobs.set("job-1", { data: stored, state: "delayed", remove: removeJob });

    await expect(harness.service.cancel({ jobId: "job-1", candidate: stored })).resolves.toEqual({ removed: true });
    expect(removeJob).toHaveBeenCalledTimes(1);
    expect(harness.removeIndex).toHaveBeenCalledWith(stored, "job-1");
  });

  it("cleans a stale checkout index even when the BullMQ job is already missing", async () => {
    const harness = createHarness();
    harness.checkoutIds.set("checkout-1", "missing-job");

    await expect(harness.service.cancelByCheckout({
      shopId: "shop-1",
      checkoutToken: "checkout-1",
    })).resolves.toEqual({ removed: true });
    expect(harness.removeIndex).toHaveBeenCalledWith({
      shopId: "shop-1",
      checkoutToken: "checkout-1",
      cartToken: null,
    }, "missing-job");
  });

  it.each(["delayed", "waiting"])("re-resolves under the checkout lock before cancelling a %s cart candidate", async (state) => {
    const harness = createHarness();
    const stored = candidate();
    const removeJob = vi.fn(async () => undefined);
    harness.cartIds.set("cart-1", "job-1");
    harness.jobs.set("job-1", { data: stored, state, remove: removeJob });

    await expect(harness.service.cancelByCart({
      shopId: "shop-1",
      cartToken: "cart-1",
    })).resolves.toEqual({ outcome: "cancelled", jobId: "job-1" });
    expect(harness.withCheckoutLock).toHaveBeenCalledWith("shop-1", "checkout-1", expect.any(Function));
    expect(harness.indexStore.findByCart).toHaveBeenCalledTimes(2);
    expect(removeJob).toHaveBeenCalledTimes(1);
  });

  it("does not cancel a cart candidate whose queue state is no longer cancellable", async () => {
    const harness = createHarness();
    harness.cartIds.set("cart-1", "job-1");
    harness.jobs.set("job-1", {
      data: candidate(),
      state: "active",
      remove: vi.fn(async () => undefined),
    });

    await expect(harness.service.cancelByCart({
      shopId: "shop-1",
      cartToken: "cart-1",
    })).resolves.toEqual({ outcome: "not-reschedulable", state: "active", jobId: "job-1" });
    expect(harness.removeIndex).not.toHaveBeenCalled();
  });
});
