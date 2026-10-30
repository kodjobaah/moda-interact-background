import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WooRecoveryOrchestratorService, WooRecoveryRetryRequired,
  type WooRecoveryOrchestratorDependencies,
} from "../../../../src/services/woocommerce-recovery/woo-recovery-orchestrator.service.js";
import type { WooPendingCandidate } from "../../../../src/services/woocommerce-recovery/contracts.js";
import type { WooCheckoutCapture } from "../../../../src/events/woo-checkout-capture.js";
import type { WooOrderCapture } from "../../../../src/events/woo-order-capture.js";

const checkout = { shopId: "shop-1", checkoutKey: "checkout-1", eventId: "event-1" } as WooCheckoutCapture;
const order = { shopId: "shop-1", checkoutKey: "checkout-1", eventId: "order-1" } as WooOrderCapture;
const candidate: WooPendingCandidate = {
  source: "woocommerce", shopId: "shop-1", checkoutToken: "checkout-1", generation: 1,
  lastEventId: "event-1", lastActivityAt: "2026-10-25T00:00:00.000Z",
  basket: { kind: "empty" },
};

const dependencies = () => {
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
  const deps = {
    checkout: { handleCheckout: vi.fn().mockResolvedValue({ kind: "scheduled", dueAt: "2026-10-26T00:00:00.000Z", generation: 1 }) },
    order: { reconcileOrder: vi.fn().mockResolvedValue({ kind: "placed-suppressed" }) },
    admission: { evaluateMatured: vi.fn().mockResolvedValue({ kind: "created", recoveryId: "recovery-1", generation: 1 }) },
    outreach: {
      settleResumed: vi.fn().mockResolvedValue(undefined),
      enqueueInitial: vi.fn().mockResolvedValue({ kind: "queued", attemptId: "attempt-1" }),
      processInitial: vi.fn().mockResolvedValue({ kind: "sent", attemptId: "attempt-1" }),
    },
    assertWooShop: vi.fn(async () => {}),
    clearMatured: vi.fn(async () => {}),
    assertInitialAttempt: vi.fn(async () => {}),
    logger: { child: () => log },
  };
  return { deps, log, service: new WooRecoveryOrchestratorService(deps as unknown as WooRecoveryOrchestratorDependencies) };
};

describe("ARCH-048-BACKGROUND-005 orchestrator", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delegates checkout scheduling without billing, sending or admission", async () => {
    const f = dependencies();
    await expect(f.service.onCheckout(checkout)).resolves.toMatchObject({ kind: "scheduled" });
    expect(f.deps.checkout.handleCheckout).toHaveBeenCalledWith(checkout);
    expect(f.deps.admission.evaluateMatured).not.toHaveBeenCalled();
    expect(f.deps.outreach.enqueueInitial).not.toHaveBeenCalled();
  });

  it("settles the old recovery on resumed checkout without enqueueing its initial again", async () => {
    const f = dependencies();
    f.deps.checkout.handleCheckout.mockResolvedValue({
      kind: "resumed", previousRecoveryId: "recovery-1", nextGeneration: 2, candidateOutcome: "scheduled",
    });
    await f.service.onCheckout(checkout);
    expect(f.deps.outreach.settleResumed).toHaveBeenCalledExactlyOnceWith("recovery-1");
    expect(f.deps.outreach.enqueueInitial).not.toHaveBeenCalled();
    expect(f.deps.outreach.processInitial).not.toHaveBeenCalled();
  });

  it("repairs only the exact admission-origin checkout initial", async () => {
    const f = dependencies();
    f.deps.checkout.handleCheckout.mockResolvedValue({
      kind: "repair-existing-initial", recoveryId: "recovery-1", generation: 1,
    });
    await f.service.onCheckout(checkout);
    expect(f.deps.outreach.enqueueInitial).toHaveBeenCalledExactlyOnceWith("recovery-1");
    f.deps.checkout.handleCheckout.mockResolvedValue({ kind: "existing-recovery", recoveryId: "recovery-1" });
    f.deps.outreach.enqueueInitial.mockClear();
    await f.service.onCheckout(checkout);
    expect(f.deps.outreach.enqueueInitial).not.toHaveBeenCalled();
  });

  it("does not bypass a refused shop or a failed checkout adapter", async () => {
    const f = dependencies();
    const rejected = new Error("repository failed");
    f.deps.assertWooShop.mockRejectedValueOnce(rejected);
    await expect(f.service.onCheckout(checkout)).rejects.toBe(rejected);
    expect(f.deps.checkout.handleCheckout).not.toHaveBeenCalled();
    f.deps.checkout.handleCheckout.mockRejectedValueOnce(rejected);
    await expect(f.service.onCheckout(checkout)).rejects.toBe(rejected);
    expect(f.log.info).not.toHaveBeenCalled();
  });

  it("routes placed/paid/cancelled events through BG002 regardless of candidate existence", async () => {
    const f = dependencies();
    await expect(f.service.onOrder(order)).resolves.toEqual({ kind: "placed-suppressed" });
    expect(f.deps.order.reconcileOrder).toHaveBeenCalledExactlyOnceWith(order);
    expect(f.deps.admission.evaluateMatured).not.toHaveBeenCalled();
    expect(f.deps.outreach.enqueueInitial).not.toHaveBeenCalled();
  });

  it("propagates an order repository error without a completed outcome", async () => {
    const f = dependencies();
    const error = new Error("order DB failure");
    f.deps.order.reconcileOrder.mockRejectedValue(error);
    await expect(f.service.onOrder(order)).rejects.toBe(error);
    expect(f.log.info).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "created", generation: 1 },
    { kind: "already-exists", generation: 1, repairInitial: true, status: "DETECTED" },
  ])("enqueues a created or proven same-generation repair and cleans the completed candidate", async (outcome) => {
    const f = dependencies();
    f.deps.admission.evaluateMatured.mockResolvedValue({ ...outcome, recoveryId: "recovery-1" });
    await f.service.onCandidateMatured(candidate, { jobId: "woo-candidate-1" });
    expect(f.deps.admission.evaluateMatured).toHaveBeenCalledExactlyOnceWith(candidate, { jobId: "woo-candidate-1" });
    expect(f.deps.outreach.enqueueInitial).toHaveBeenCalledExactlyOnceWith("recovery-1");
    expect(f.deps.clearMatured).toHaveBeenCalledExactlyOnceWith(candidate, "woo-candidate-1");
  });

  it.each([
    { kind: "already-exists", recoveryId: "old", status: "MESSAGE_SENT", generation: 1, repairInitial: false },
    { kind: "already-exists", recoveryId: "old", status: "DETECTED", generation: 2, repairInitial: true },
  ])("does not enqueue an unproven or other-generation existing recovery", async (outcome) => {
    const f = dependencies();
    f.deps.admission.evaluateMatured.mockResolvedValue(outcome);
    await f.service.onCandidateMatured(candidate, { jobId: "woo-candidate-1" });
    expect(f.deps.outreach.enqueueInitial).not.toHaveBeenCalled();
    expect(f.deps.clearMatured).toHaveBeenCalledExactlyOnceWith(candidate, "woo-candidate-1");
  });

  it("keeps denied/superseded work from ever queuing an initial attempt", async () => {
    for (const kind of ["denied", "superseded"]) {
      const f = dependencies();
      f.deps.admission.evaluateMatured.mockResolvedValue({ kind, reason: "reason" });
      await f.service.onCandidateMatured(candidate, { jobId: "woo-candidate-1" });
      expect(f.deps.outreach.enqueueInitial).not.toHaveBeenCalled();
      expect(f.deps.clearMatured).toHaveBeenCalledOnce();
    }
  });

  it("preserves the original exception and candidate index after DB INSERT→enqueue crash", async () => {
    const f = dependencies();
    const error = new Error("Redis enqueue unavailable");
    f.deps.outreach.enqueueInitial.mockRejectedValue(error);
    await expect(f.service.onCandidateMatured(candidate, { jobId: "woo-candidate-1" })).rejects.toBe(error);
    expect(f.deps.clearMatured).not.toHaveBeenCalled();
    expect(f.log.info).not.toHaveBeenCalled();
  });

  it.each(["admission", "checkout-resume", "dispatch-initial"])("converts %s retryable result into a failed BullMQ attempt", async (stage) => {
    const f = dependencies();
    if (stage === "admission") {
      f.deps.admission.evaluateMatured.mockResolvedValue({ kind: "deferred", reason: "CANDIDATE_NOT_MATURE" });
      await expect(f.service.onCandidateMatured(candidate, { jobId: "woo-candidate-1" }))
        .rejects.toBeInstanceOf(WooRecoveryRetryRequired);
      expect(f.deps.clearMatured).not.toHaveBeenCalled();
    } else if (stage === "checkout-resume") {
      f.deps.checkout.handleCheckout.mockResolvedValue({
        kind: "repair-existing-initial", recoveryId: "recovery-1", generation: 1,
      });
      f.deps.outreach.enqueueInitial.mockResolvedValue({ kind: "failed-retryable", reason: "REDIS_UNAVAILABLE" });
      await expect(f.service.onCheckout(checkout)).rejects.toBeInstanceOf(WooRecoveryRetryRequired);
    } else {
      f.deps.outreach.processInitial.mockResolvedValue({ kind: "failed-retryable", reason: "PROVIDER_UNAVAILABLE" });
      await expect(f.service.onInitialDispatch("recovery-1", "attempt-1"))
        .rejects.toBeInstanceOf(WooRecoveryRetryRequired);
    }
    expect(f.log.info).not.toHaveBeenCalled();
  });

  it("retains candidate when the accepted notice/admission hook fails", async () => {
    const f = dependencies();
    const error = new Error("Support notice DB failed");
    f.deps.admission.evaluateMatured.mockRejectedValue(error);
    await expect(f.service.onCandidateMatured(candidate, { jobId: "woo-candidate-1" })).rejects.toBe(error);
    expect(f.deps.clearMatured).not.toHaveBeenCalled();
  });

  it("requires initial attempt/recovery ownership and never retries a second send", async () => {
    const f = dependencies();
    const error = new Error("attempt belongs to another recovery");
    f.deps.assertInitialAttempt.mockRejectedValueOnce(error);
    await expect(f.service.onInitialDispatch("recovery-1", "attempt-2")).rejects.toBe(error);
    expect(f.deps.outreach.processInitial).not.toHaveBeenCalled();
    await expect(f.service.onInitialDispatch("recovery-1", "attempt-1"))
      .resolves.toEqual({ kind: "sent", attemptId: "attempt-1" });
    expect(f.deps.outreach.processInitial).toHaveBeenCalledExactlyOnceWith("recovery-1");
  });
});
