import { describe, expect, it, vi } from "vitest";

import type { PendingRecoveryCandidate } from "../../../../src/domain/pending-recovery-candidate.js";
import { PendingRecoveryCandidateActivityService } from "../../../../src/services/pending-recovery-candidate/candidate-activity.service.js";

const baseCandidate: PendingRecoveryCandidate = {
  shopId: "shop-1",
  shopDomain: "shop.myshopify.com",
  checkoutToken: "checkout-1",
  cartToken: "cart-1",
  abandonedCheckoutUrl: null,
  checkoutCreatedAt: "2026-08-28T00:00:00.000Z",
  lastActivityAt: "2026-08-28T00:00:00.000Z",
  internationalContext: {
    languageTag: "en-GB",
    languageSource: "shopify",
    countryCode: "GB",
    currencyCode: "GBP",
    timeZone: "Europe/London",
  },
};

function createHarness(input?: { state?: string; jobExists?: boolean }) {
  const state = input?.state ?? "delayed";
  const job = {
    getState: vi.fn(async () => state),
    updateData: vi.fn(async () => undefined),
    changeDelay: vi.fn(async () => undefined),
  };
  const resolved = { jobId: "job-1", candidate: baseCandidate };
  const resolveCandidate = vi.fn(async () => resolved);
  const withCheckoutLock = vi.fn(async (_shopId, _checkoutToken, callback) => callback());
  const cancelCandidate = vi.fn(async () => ({ removed: true as const }));
  const resolveDelayMinutes = vi.fn(async () => 45);
  const getQueue = vi.fn(() => ({
    getJob: vi.fn(async () => input?.jobExists === false ? null : job),
  }));
  const candidateIndexStore = {
    upsert: vi.fn(async () => undefined),
  };
  const service = new PendingRecoveryCandidateActivityService({
    resolveCandidate,
    withCheckoutLock,
    cancelCandidate,
    resolveDelayMinutes,
    getQueue,
    candidateIndexStore,
    now: () => Date.parse("2026-08-28T01:00:00.000Z"),
  });

  return {
    service,
    job,
    resolveCandidate,
    withCheckoutLock,
    cancelCandidate,
    resolveDelayMinutes,
    getQueue,
    candidateIndexStore,
  };
}

describe("PendingRecoveryCandidateActivityService", () => {
  it("reschedules newer delayed activity using the latest recovery policy", async () => {
    const harness = createHarness();

    const result = await harness.service.refresh({
      shopId: "shop-1",
      checkoutToken: "checkout-1",
      cartToken: "cart-1",
      activityAt: "2026-08-28T01:00:00.000Z",
      isEmpty: false,
      internationalContext: {
        languageTag: "fr-FR",
        languageSource: "detected",
        countryCode: null,
        currencyCode: "EUR",
        timeZone: null,
      },
    });

    expect(result).toMatchObject({
      outcome: "rescheduled",
      jobId: "job-1",
      candidate: {
        lastActivityAt: "2026-08-28T01:00:00.000Z",
        internationalContext: {
          languageTag: "fr-FR",
          languageSource: "detected",
          countryCode: "GB",
          currencyCode: "EUR",
          timeZone: "Europe/London",
        },
      },
    });
    expect(harness.withCheckoutLock).toHaveBeenCalledWith(
      "shop-1",
      "checkout-1",
      expect.any(Function),
    );
    expect(harness.resolveCandidate).toHaveBeenCalledTimes(2);
    expect(harness.resolveDelayMinutes).toHaveBeenCalledWith("shop-1");
    expect(harness.job.updateData).toHaveBeenCalledTimes(1);
    expect(harness.job.changeDelay).toHaveBeenCalledWith(45 * 60_000);
    expect(harness.candidateIndexStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-1",
      delayMinutes: 45,
      dueAtMs: Date.parse("2026-08-28T01:45:00.000Z"),
      shouldIndexShop: true,
    }));
  });

  it("returns stale before reading or mutating the queue", async () => {
    const harness = createHarness();

    await expect(harness.service.refresh({
      shopId: "shop-1",
      checkoutToken: "checkout-1",
      cartToken: null,
      activityAt: "2026-08-27T23:59:00.000Z",
      isEmpty: true,
    })).resolves.toMatchObject({ outcome: "stale", jobId: "job-1" });

    expect(harness.getQueue).not.toHaveBeenCalled();
    expect(harness.cancelCandidate).not.toHaveBeenCalled();
    expect(harness.resolveDelayMinutes).not.toHaveBeenCalled();
  });

  it.each(["delayed", "waiting"])(
    "cancels an empty-cart candidate in the supported %s state",
    async (state) => {
      const harness = createHarness({ state });

      await expect(harness.service.refresh({
        shopId: "shop-1",
        checkoutToken: null,
        cartToken: "cart-1",
        activityAt: "2026-08-28T00:01:00.000Z",
        isEmpty: true,
      })).resolves.toEqual({ outcome: "cancelled", jobId: "job-1" });

      expect(harness.cancelCandidate).toHaveBeenCalledWith({
        jobId: "job-1",
        candidate: baseCandidate,
      });
      expect(harness.job.updateData).not.toHaveBeenCalled();
    },
  );

  it.each(["waiting", "active", "failed", "completed"])(
    "does not reschedule a non-delayed %s candidate",
    async (state) => {
      const harness = createHarness({ state });

      await expect(harness.service.refresh({
        shopId: "shop-1",
        checkoutToken: "checkout-1",
        cartToken: null,
        activityAt: "2026-08-28T01:00:00.000Z",
        isEmpty: false,
      })).resolves.toEqual({
        outcome: "not-reschedulable",
        state,
        jobId: "job-1",
      });

      expect(harness.job.updateData).not.toHaveBeenCalled();
      expect(harness.resolveDelayMinutes).not.toHaveBeenCalled();
    },
  );

  it("re-resolves after acquiring the checkout lock and stops when the candidate disappears", async () => {
    const harness = createHarness();
    harness.resolveCandidate
      .mockResolvedValueOnce({ jobId: "job-1", candidate: baseCandidate })
      .mockResolvedValueOnce(null);

    await expect(harness.service.refresh({
      shopId: "shop-1",
      checkoutToken: "checkout-1",
      cartToken: null,
      activityAt: "2026-08-28T01:00:00.000Z",
      isEmpty: false,
    })).resolves.toEqual({ outcome: "not-found" });

    expect(harness.getQueue).not.toHaveBeenCalled();
  });

  it("returns not-found when the indexed BullMQ job has disappeared", async () => {
    const harness = createHarness({ jobExists: false });

    await expect(harness.service.refresh({
      shopId: "shop-1",
      checkoutToken: "checkout-1",
      cartToken: null,
      activityAt: "2026-08-28T01:00:00.000Z",
      isEmpty: false,
    })).resolves.toEqual({ outcome: "not-found" });

    expect(harness.candidateIndexStore.upsert).not.toHaveBeenCalled();
  });

  it("rejects a cart alias that no longer matches the resolved candidate", async () => {
    const harness = createHarness();

    await expect(harness.service.refresh({
      shopId: "shop-1",
      checkoutToken: null,
      cartToken: "different-cart",
      activityAt: "2026-08-28T01:00:00.000Z",
      isEmpty: false,
    })).resolves.toEqual({ outcome: "not-found" });

    expect(harness.getQueue).not.toHaveBeenCalled();
  });
});
