import { createLogger, type LogRecord } from "@modainteract/moda-interact-shared/logging";
import { describe, expect, it, vi } from "vitest";
import {
  WooRecoveryOrchestratorService, WooRecoveryRetryRequired,
  type WooRecoveryOrchestratorDependencies,
} from "../../../../src/services/woocommerce-recovery/woo-recovery-orchestrator.service.js";
import type { WooPendingCandidate, WooAdmissionOutcome, WooOutreachEnqueueOutcome, WooOutreachDispatchOutcome } from "../../../../src/services/woocommerce-recovery/contracts.js";

const candidate: WooPendingCandidate = {
  source: "woocommerce", shopId: "shop-1", checkoutToken: "opaque-checkout-secret",
  lastEventId: "opaque-event-secret", lastActivityAt: "2026-10-24T00:00:00.000Z",
  basket: { kind: "empty" },
};
const checkout = { shopId: "shop-1" } as Parameters<WooRecoveryOrchestratorService["onCheckout"]>[0];
const order = { shopId: "shop-1" } as Parameters<WooRecoveryOrchestratorService["onOrder"]>[0];

function fixture(sink: (record: LogRecord) => void = () => undefined) {
  const deps = {
    checkout: { handleCheckout: vi.fn(async () => ({ kind: "scheduled" as const, dueAt: "2026-10-27T00:00:00.000Z" })) },
    order: { reconcileOrder: vi.fn(async () => ({ kind: "placed-suppressed" as const })) },
    admission: { evaluateMatured: vi.fn(async () => ({ kind: "created" as const, recoveryId: "recovery-1" } as WooAdmissionOutcome)) },
    outreach: {
      enqueueInitial: vi.fn(async () => ({ kind: "queued" as const, attemptId: "attempt-1" } as WooOutreachEnqueueOutcome)),
      processInitial: vi.fn(async () => ({ kind: "sent" as const, attemptId: "attempt-1" } as WooOutreachDispatchOutcome)),
    },
    assertWooShop: vi.fn(async () => undefined),
    clearMatured: vi.fn(async () => undefined),
    assertInitialAttempt: vi.fn(async () => undefined),
    logger: createLogger({ serviceName: "moda-recovery-worker", environment: "test", sink }),
  } satisfies WooRecoveryOrchestratorDependencies;
  return { deps, service: new WooRecoveryOrchestratorService(deps) };
}

describe("ARCH-048-BG005 exception propagation and approved logger isolation", () => {
  it("does not turn a healthy Woo checkout, order, maturity or dispatch into a failure when the logging sink throws", async () => {
    const f = fixture(() => { throw new Error("logging sink unavailable"); });
    await expect(f.service.onCheckout(checkout)).resolves.toMatchObject({ kind: "scheduled" });
    await expect(f.service.onOrder(order)).resolves.toMatchObject({ kind: "placed-suppressed" });
    await expect(f.service.onCandidateMatured(candidate, { jobId: "woo-candidate-1" }))
      .resolves.toMatchObject({ kind: "created" });
    await expect(f.service.onInitialDispatch("recovery-1", "attempt-1"))
      .resolves.toMatchObject({ kind: "sent" });
    expect(f.deps.clearMatured).toHaveBeenCalledOnce();
  });

  it.each(["checkout", "order", "admission", "initial"] as const)(
    "preserves the exact %s dependency rejection even when the logging sink is unavailable",
    async (kind) => {
      const f = fixture(() => { throw new Error("logging sink unavailable"); });
      const error = new Error("dependency-failure with private checkout details");
      if (kind === "checkout") {
        f.deps.checkout.handleCheckout.mockRejectedValueOnce(error);
        await expect(f.service.onCheckout(checkout)).rejects.toBe(error);
      } else if (kind === "order") {
        f.deps.order.reconcileOrder.mockRejectedValueOnce(error);
        await expect(f.service.onOrder(order)).rejects.toBe(error);
      } else if (kind === "admission") {
        // Also covers an awaited consent-denial merchant-notice callback inside BG003.
        f.deps.admission.evaluateMatured.mockRejectedValueOnce(error);
        await expect(f.service.onCandidateMatured(candidate, { jobId: "woo-candidate-1" })).rejects.toBe(error);
      } else {
        f.deps.outreach.processInitial.mockRejectedValueOnce(error);
        await expect(f.service.onInitialDispatch("recovery-1", "attempt-1")).rejects.toBe(error);
      }
      expect(f.deps.clearMatured).not.toHaveBeenCalled();
    },
  );

  it("preserves the durable recovery on failed enqueue and retries the identical recovery without a second admission", async () => {
    const f = fixture();
    const interrupted = new Error("Redis queue add failed");
    f.deps.outreach.enqueueInitial.mockRejectedValueOnce(interrupted);
    await expect(f.service.onCandidateMatured(candidate, { jobId: "woo-candidate-1" })).rejects.toBe(interrupted);
    expect(f.deps.clearMatured).not.toHaveBeenCalled();
    f.deps.admission.evaluateMatured.mockResolvedValueOnce({
      kind: "already-exists", recoveryId: "recovery-1", status: "DETECTED",
    });
    await expect(f.service.onCandidateMatured(candidate, { jobId: "woo-candidate-1" }))
      .resolves.toMatchObject({ kind: "already-exists", recoveryId: "recovery-1" });
    expect(f.deps.outreach.enqueueInitial).toHaveBeenNthCalledWith(2, "recovery-1");
    expect(f.deps.clearMatured).toHaveBeenCalledOnce();
  });

  it("fails retryable enqueue and provider results instead of acknowledging a completed job", async () => {
    const f = fixture();
    f.deps.outreach.enqueueInitial.mockResolvedValueOnce({ kind: "failed-retryable", reason: "REDIS_UNAVAILABLE" });
    await expect(f.service.onCandidateMatured(candidate, { jobId: "woo-candidate-1" }))
      .rejects.toBeInstanceOf(WooRecoveryRetryRequired);
    expect(f.deps.clearMatured).not.toHaveBeenCalled();
    f.deps.outreach.processInitial.mockResolvedValueOnce({ kind: "failed-retryable", reason: "PROVIDER_UNKNOWN" });
    await expect(f.service.onInitialDispatch("recovery-1", "attempt-1"))
      .rejects.toBeInstanceOf(WooRecoveryRetryRequired);
  });

  it("emits only scoped identifiers in successful orchestration logs, never customer or checkout tokens", async () => {
    const records: LogRecord[] = [];
    const f = fixture((record) => { records.push(record); });
    await f.service.onCandidateMatured(candidate, { jobId: "woo-candidate-1" });
    const serialized = JSON.stringify(records);
    expect(serialized).toContain("woocommerce.recovery.maturity.handled");
    expect(serialized).not.toContain(candidate.checkoutToken);
    expect(serialized).not.toContain(candidate.lastEventId);
    expect(serialized).not.toContain("phone");
  });
});
