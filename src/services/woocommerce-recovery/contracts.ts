/**
 * ARCH-048-BACKGROUND-006: Background-local Woo recovery service contracts.
 *
 * These are dependency-injection boundaries, not a new queue or API schema.
 * Callers must first validate and authenticate events through the existing
 * ARCH-035 capture parsers; these types do not establish source trust.
 *
 * BG001–BG004 implement the capabilities independently; BG005 composes them.
 * This file must not import their concrete implementations or any workers.
 */
import type { WooCheckoutCapture } from "../../events/woo-checkout-capture.js";
import type { WooOrderCapture } from "../../events/woo-order-capture.js";

/** Woo's authenticated checkoutKey is the checkoutToken, scoped to its shop. */
export type WooCheckoutRef = Readonly<{
  shopId: string;
  checkoutToken: string;
}>;

type WooCheckoutItem = NonNullable<WooCheckoutCapture["checkout"]["items"]>[number];

/**
 * `nonempty` requires a validated, bounded checkout snapshot with >=1 item.
 * `empty` means the producer explicitly supplied items: [].
 * Missing/oversized items or conflicting versions are never proof of emptiness.
 */
export type WooBasketEvidence =
  | Readonly<{
      kind: "nonempty";
      checkout: WooCheckoutCapture["checkout"] & {
        items: [WooCheckoutItem, ...WooCheckoutItem[]];
      };
    }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{
      kind: "unknown";
      reason: "items-omitted" | "conflicting-events" | "incomplete-snapshot";
    }>;

/** Internal candidate only: never derive a restore URL or Woo session token. */
export type WooPendingCandidate = Readonly<
  WooCheckoutRef & {
  source: "woocommerce";
    /** Required identity component for the Woo candidate v2 job format. */
    generation: number;
    /** Last *accepted* Woo checkout event ID (not a fabricated revision). */
    lastEventId: string;
    lastActivityAt: string;
    basket: WooBasketEvidence;
  }
>;

/** Observations are limited to order events successfully received by Moda. */
export type WooTerminalObservation =
  | Readonly<{ kind: "none-observed" }>
  | Readonly<{
      kind: "order-placed" | "order-paid" | "order-cancelled";
      orderId: string;
    }>
  | Readonly<{ kind: "ambiguous"; reason: string }>;

/** BG001: candidate storage/index adapter; absence is not proof of checkout safety. */
export interface WooCandidateManager {
  getPending(ref: WooCheckoutRef, expectedGeneration?: number): Promise<WooPendingCandidate | null>;
  cancelPending(ref: WooCheckoutRef, expectedGeneration?: number): Promise<"cancelled" | "absent">;
}

/** BG002: observed order evidence, never an HTTP/live Woo provider lookup. */
export interface WooObservedOrderStateReader {
  read(ref: WooCheckoutRef): Promise<WooTerminalObservation>;
}

/**
 * BG002: coordinate exclusively by (shopId, checkoutToken).
 * Implementations must fence/reject unsafe acquisition: a 10s lease and a 1h
 * terminal marker alone cannot guarantee durable exclusion or event ordering.
 */
export interface WooCheckoutCoordinator {
  withCheckoutLock<T>(ref: WooCheckoutRef, run: () => Promise<T>): Promise<T>;
}

export type WooCheckoutActivityOutcome =
  | Readonly<{ kind: "scheduled" | "rescheduled"; dueAt: string; generation: number }>
  | Readonly<{ kind: "resumed"; previousRecoveryId: string; nextGeneration: number;
      candidateOutcome: "scheduled" | "rescheduled" | "cancelled-empty" | "deferred-ambiguous"; dueAt?: string }>
  | Readonly<{ kind: "repair-existing-initial"; recoveryId: string; generation: number }>
  | Readonly<{ kind: "existing-recovery"; recoveryId: string }>
  | Readonly<{
      kind:
        | "cancelled-empty"
        | "ignored-terminal"
        | "ignored-stale"
        | "deferred-ambiguous"
        | "not-eligible";
      reason: string;
    }>;

/** BG001: scheduling and candidate lifecycle, not recovery admission. */
export interface WooCheckoutActivityHandler {
  handleCheckout(event: WooCheckoutCapture): Promise<WooCheckoutActivityOutcome>;
}

export type WooOrderReconciliationOutcome =
  | Readonly<{
      kind: "placed-suppressed" | "paid-terminal" | "cancelled-terminal";
      recoveryId?: string;
    }>
  | Readonly<{
      kind: "already-terminal" | "ignored-duplicate" | "ignored-stale" | "deferred-conflict";
      reason: string;
    }>;

/** BG002: order events can suppress outreach without implying payment. */
export interface WooOrderReconciler {
  reconcileOrder(event: WooOrderCapture): Promise<WooOrderReconciliationOutcome>;
}

export type WooAdmissionOutcome =
  | Readonly<{ kind: "created"; recoveryId: string; generation: number }>
  | Readonly<{ kind: "already-exists"; recoveryId: string; status: string; generation: number; repairInitial: boolean }>
  | Readonly<{ kind: "superseded" | "denied" | "deferred"; reason: string }>;

/** BG003: idempotent mature-candidate evaluation and row-only admission. */
export interface WooRecoveryAdmissionEvaluator {
  evaluateMatured(
    candidate: WooPendingCandidate,
    context: { jobId?: string },
  ): Promise<WooAdmissionOutcome>;
}

/** Enqueue is not evidence of dispatch or billing. */
export type WooOutreachEnqueueOutcome =
  | Readonly<{ kind: "queued" | "already-initialized"; attemptId?: string }>
  | Readonly<{ kind: "deferred" | "suppressed" | "failed-retryable"; reason: string }>;

/** A successful dispatch has a durable attempt ID; deferrals do not imply send. */
export type WooOutreachDispatchOutcome =
  | Readonly<{ kind: "sent" | "already-initialized"; attemptId: string }>
  | Readonly<{ kind: "deferred" | "suppressed" | "failed-retryable"; reason: string }>;

/**
 * BG004: accepts only an existing, committed CheckoutRecovery ID. Implementors
 * must verify that precondition and enforce retry-safe attempt/billing guards.
 * A checkout event, contact or uncommitted insert is not an outreach request.
 */
export interface WooRecoveryOutreachDispatcher {
  settleResumed(previousRecoveryId: string): Promise<void>;
  enqueueInitial(recoveryId: string): Promise<WooOutreachEnqueueOutcome>;
  processInitial(recoveryId: string): Promise<WooOutreachDispatchOutcome>;
}
