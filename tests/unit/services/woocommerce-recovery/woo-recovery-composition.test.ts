import { describe, expect, it, vi } from "vitest";
import type { WooPendingCandidate } from "../../../../src/services/woocommerce-recovery/contracts.js";
import { clearMaturedWooCandidate } from "../../../../src/services/woocommerce-recovery/woo-recovery-composition.js";
import { wooCandidateJobId } from "../../../../src/services/woocommerce-recovery/woo-candidate-queue.service.js";

const candidate: WooPendingCandidate = {
  source: "woocommerce", shopId: "woo-shop", checkoutToken: "opaque-checkout-key", generation: 1,
  lastEventId: "event-one", lastActivityAt: "2026-10-30T10:00:00.000Z", basket: { kind: "empty" },
};

describe("ARCH-048-BG011 exact matured-candidate cleanup", () => {
  it("preserves a successor index if it replaces the completed generation before compare-and-delete", async () => {
    const ref = { shopId: candidate.shopId, checkoutToken: candidate.checkoutToken };
    const oldJobId = wooCandidateJobId(ref, candidate.generation);
    const nextJobId = wooCandidateJobId(ref, 2);
    let indexedJobId = oldJobId;
    const index = {
      findByCheckout: vi.fn(async () => indexedJobId),
      compareAndRemoveCheckout: vi.fn(async (_checkout: typeof ref, jobId: string) => {
        // Simulate a checkout update that wins after the ownership read.
        indexedJobId = nextJobId;
        if (indexedJobId !== jobId) return false;
        indexedJobId = "";
        return true;
      }),
    };
    const queue = { getJob: vi.fn(async () => ({ data: candidate })) };
    const coordinator = { withCheckoutLock: vi.fn(async (_checkout: typeof ref, run: () => Promise<void>) => run()) };

    await clearMaturedWooCandidate({ coordinator, index, queue }, candidate, oldJobId);

    expect(index.compareAndRemoveCheckout).toHaveBeenCalledExactlyOnceWith(ref, oldJobId);
    expect(indexedJobId).toBe(nextJobId);
  });

  it("retains retry evidence when the BullMQ job no longer matches the exact generation event", async () => {
    const ref = { shopId: candidate.shopId, checkoutToken: candidate.checkoutToken };
    const jobId = wooCandidateJobId(ref, candidate.generation);
    const index = {
      findByCheckout: vi.fn(async () => jobId),
      compareAndRemoveCheckout: vi.fn(async () => true),
    };
    const queue = { getJob: vi.fn(async () => ({ data: { ...candidate, lastEventId: "newer-event" } })) };
    const coordinator = { withCheckoutLock: async (_checkout: typeof ref, run: () => Promise<void>) => run() };

    await expect(clearMaturedWooCandidate({ coordinator, index, queue }, candidate, jobId))
      .rejects.toThrow("WOO_MATURED_INDEX_OWNERSHIP_CHANGED");
    expect(index.compareAndRemoveCheckout).not.toHaveBeenCalled();
  });
});
