import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { WooCheckoutCapture } from "../../events/woo-checkout-capture.js";
import type { WooOrderCapture } from "../../events/woo-order-capture.js";
import type {
  WooCheckoutActivityHandler, WooOrderReconciler, WooRecoveryAdmissionEvaluator,
  WooRecoveryOutreachDispatcher, WooPendingCandidate, WooCheckoutActivityOutcome,
  WooOrderReconciliationOutcome, WooAdmissionOutcome, WooOutreachDispatchOutcome,
} from "./contracts.js";

/** Business deferrals are explicit failed BullMQ attempts, not successful acks. */
export class WooRecoveryRetryRequired extends Error {
  constructor(readonly stage: string, readonly reasonCode: string) {
    super(`Woo recovery retry required at ${stage}`);
  }
}

export type WooRecoveryOrchestratorDependencies = Readonly<{
  checkout: WooCheckoutActivityHandler;
  order: WooOrderReconciler;
  admission: WooRecoveryAdmissionEvaluator;
  outreach: WooRecoveryOutreachDispatcher;
  assertWooShop(shopId: string): Promise<void>;
  /** Remove only the terminal *current* candidate index, under the checkout lock. */
  clearMatured(candidate: WooPendingCandidate, jobId: string): Promise<void>;
  /** Bind a queued attempt to the same recovery, never an arbitrary Redis job ID. */
  assertInitialAttempt(recoveryId: string, attemptId: string): Promise<void>;
  logger: StructuredLogger;
}>;

function retryIfNecessary(stage: string, result: { kind: string; reason?: string }): void {
  if (result.kind === "deferred" || result.kind === "failed-retryable") {
    throw new WooRecoveryRetryRequired(stage, result.reason ?? "unknown");
  }
}

/** Thin BG005 composition boundary. All business decisions remain in BG001–BG004. */
export class WooRecoveryOrchestratorService {
  private readonly log: StructuredLogger;
  constructor(private readonly deps: WooRecoveryOrchestratorDependencies) {
    this.log = deps.logger.child({ component: "woo-recovery-orchestrator" });
  }

  async onCheckout(event: WooCheckoutCapture): Promise<WooCheckoutActivityOutcome> {
    await this.deps.assertWooShop(event.shopId);
    const outcome = await this.deps.checkout.handleCheckout(event);
    if (outcome.kind === "existing-recovery") {
      // Also repairs an INSERT→enqueue interruption. BG004 examines the
      // committed sequence-one attempt and never issues a second first send.
      const enqueue = await this.deps.outreach.enqueueInitial(outcome.recoveryId);
      retryIfNecessary("checkout-resume", enqueue);
    }
    this.log.info("woocommerce.recovery.checkout.handled", { shopId: event.shopId, outcome: outcome.kind });
    return outcome;
  }

  async onOrder(event: WooOrderCapture): Promise<WooOrderReconciliationOutcome> {
    await this.deps.assertWooShop(event.shopId);
    const outcome = await this.deps.order.reconcileOrder(event);
    this.log.info("woocommerce.recovery.order.handled", { shopId: event.shopId, outcome: outcome.kind });
    return outcome;
  }

  async onCandidateMatured(
    candidate: WooPendingCandidate,
    context: { jobId: string },
  ): Promise<WooAdmissionOutcome> {
    await this.deps.assertWooShop(candidate.shopId);
    const outcome = await this.deps.admission.evaluateMatured(candidate, context);
    if (outcome.kind === "created" || outcome.kind === "already-exists") {
      const enqueue = await this.deps.outreach.enqueueInitial(outcome.recoveryId);
      retryIfNecessary("enqueue-initial", enqueue);
    } else {
      retryIfNecessary("admission", outcome);
    }
    // Never clear after an exception or deferral. A retry can recover a
    // previously committed CheckoutRecovery and republish its first attempt.
    await this.deps.clearMatured(candidate, context.jobId);
    this.log.info("woocommerce.recovery.maturity.handled", {
      shopId: candidate.shopId, outcome: outcome.kind,
    });
    return outcome;
  }

  async onInitialDispatch(recoveryId: string, attemptId: string): Promise<WooOutreachDispatchOutcome> {
    await this.deps.assertInitialAttempt(recoveryId, attemptId);
    const outcome = await this.deps.outreach.processInitial(recoveryId);
    retryIfNecessary("dispatch-initial", outcome);
    this.log.info("woocommerce.recovery.initial.handled", { recoveryId, outcome: outcome.kind });
    return outcome;
  }
}
