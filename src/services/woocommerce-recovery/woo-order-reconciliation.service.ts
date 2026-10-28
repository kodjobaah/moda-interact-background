import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { WooOrderCapture } from "../../events/woo-order-capture.js";
import type {
  WooCandidateManager,
  WooCheckoutCoordinator,
  WooCheckoutRef,
  WooObservedOrderStateReader,
  WooOrderReconciler,
  WooOrderReconciliationOutcome,
  WooTerminalObservation,
} from "./contracts.js";

/**
 * The shared recovery-policy schema permits up to 10,080 minutes (seven days).
 * Retain order-first suppression for that full delay PLUS 48 hours of job
 * retries/replays, starting at *receipt* time, not the Woo event time.
 * This is intentionally bounded evidence, not a permanent order ledger.
 */
export const WOO_ORDER_EVIDENCE_TTL_MS = (10_080 + 48 * 60) * 60_000;

const KINDS = {
  ORDER_PLACED: "order-placed",
  ORDER_PAID: "order-paid",
  ORDER_CANCELLED: "order-cancelled",
} as const;

type ObservedKind = (typeof KINDS)[keyof typeof KINDS];
export type WooStoredOrderObservation = Readonly<{
  kind: ObservedKind;
  eventId: string;
  orderId: string;
  occurredAt: string;
  /** A received conflicting callback cannot be ordered as authoritative. */
  ambiguity?: "different-order-id" | "equal-time-conflict" | "same-event-id-conflict";
}>;

/** The private write seam is injected for fault-injection and isolated tests. */
export interface WooOrderEvidenceStore extends WooObservedOrderStateReader {
  inspect(ref: WooCheckoutRef): Promise<WooStoredOrderObservation | null>;
  persist(ref: WooCheckoutRef, value: WooStoredOrderObservation): Promise<void>;
}

type EvidenceRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
};

function evidenceKey(ref: WooCheckoutRef): string {
  const digest = createHash("sha256")
    .update(ref.shopId).update("\0").update(ref.checkoutToken).digest("hex");
  return `woo-recovery:observed-order:v1:${digest}`;
}

function decodeEvidence(value: string): WooStoredOrderObservation {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("woo-order-evidence-invalid");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("woo-order-evidence-invalid");
  }
  const evidence = raw as Partial<Record<keyof WooStoredOrderObservation, unknown>>;
  if (!["order-placed", "order-paid", "order-cancelled"].includes(String(evidence.kind)) ||
      typeof evidence.eventId !== "string" || !evidence.eventId || evidence.eventId.length > 128 ||
      typeof evidence.orderId !== "string" || !evidence.orderId || evidence.orderId.length > 128 ||
      typeof evidence.occurredAt !== "string" || !Number.isFinite(Date.parse(evidence.occurredAt)) ||
      (evidence.ambiguity !== undefined && !["different-order-id", "equal-time-conflict", "same-event-id-conflict"].includes(String(evidence.ambiguity)))) {
    throw new Error("woo-order-evidence-invalid");
  }
  return evidence as WooStoredOrderObservation;
}

/** BG001/BG003/BG004 inject this same reader; no live Woo HTTP lookup. */
export class WooOrderTerminalEvidenceStore implements WooOrderEvidenceStore {
  constructor(private readonly redis: EvidenceRedis) {}

  async inspect(ref: WooCheckoutRef): Promise<WooStoredOrderObservation | null> {
    const value = await this.redis.get(evidenceKey(ref));
    return value === null ? null : decodeEvidence(value);
  }

  async read(ref: WooCheckoutRef): Promise<WooTerminalObservation> {
    const observed = await this.inspect(ref);
    return observed === null
      ? { kind: "none-observed" }
      : observed.ambiguity
        ? { kind: "ambiguous", reason: observed.ambiguity }
        : { kind: observed.kind, orderId: observed.orderId };
  }

  async persist(ref: WooCheckoutRef, observation: WooStoredOrderObservation): Promise<void> {
    const result = await this.redis.set(
      evidenceKey(ref), JSON.stringify(observation), "PX", WOO_ORDER_EVIDENCE_TTL_MS,
    );
    if (result !== "OK") throw new Error("woo-order-evidence-write-unconfirmed");
  }
}

/** Inject WooCheckoutLeaseGuard from the existing checkout order guard module. */
export class WooCheckoutCoordinatorService implements WooCheckoutCoordinator {
  constructor(private readonly guard: {
    withCheckoutLock<T>(shopId: string, checkoutToken: string, run: () => Promise<T>): Promise<T>;
  }) {}

  withCheckoutLock<T>(ref: WooCheckoutRef, run: () => Promise<T>): Promise<T> {
    return this.guard.withCheckoutLock(ref.shopId, ref.checkoutToken, run);
  }
}

type ReconciliationDatabase = Pick<
  PrismaClient,
  "checkoutRecovery" | "checkoutRecoveryStatusHistory" | "$transaction"
>;

type OrderDecision =
  | { kind: "accepted"; effective: WooStoredOrderObservation }
  | { kind: "ignored-duplicate" | "ignored-stale" | "deferred-conflict"; reason: string; effective: WooStoredOrderObservation };

function decide(
  previously: WooStoredOrderObservation | null,
  incoming: WooStoredOrderObservation,
): OrderDecision {
  if (!previously) return { kind: "accepted", effective: incoming };
  if (previously.orderId !== incoming.orderId) {
    return { kind: "deferred-conflict", reason: "different-order-id",
      effective: { ...previously, ambiguity: "different-order-id" } };
  }
  if (previously.eventId === incoming.eventId) {
    if (previously.kind !== incoming.kind || previously.occurredAt !== incoming.occurredAt) {
      return { kind: "deferred-conflict", reason: "same-event-id-conflict",
        effective: { ...previously, ambiguity: "same-event-id-conflict" } };
    }
    return { kind: "ignored-duplicate", reason: "event-replayed", effective: previously };
  }
  const difference = Date.parse(incoming.occurredAt) - Date.parse(previously.occurredAt);
  if (difference < 0) {
    return { kind: "ignored-stale", reason: "older-event", effective: previously };
  }
  if (difference === 0 && previously.kind !== incoming.kind) {
    return { kind: "deferred-conflict", reason: "equal-time-conflict",
      effective: { ...previously, ambiguity: "equal-time-conflict" } };
  }
  // A placed callback cannot demote an observed paid/cancelled order even if
  // Woo sends a second placed callback with a later timestamp.
  if (incoming.kind === "order-placed" && previously.kind !== "order-placed") {
    return { kind: "ignored-stale", reason: "placed-after-terminal", effective: previously };
  }
  if (previously.kind === incoming.kind) {
    return {
      kind: "ignored-duplicate", reason: "unchanged-order-state",
      effective: difference > 0
        ? { ...incoming, ...(previously.ambiguity ? { ambiguity: previously.ambiguity } : {}) }
        : previously,
    };
  }
  // PAID/CANCELLED with *strictly later* timestamps may replace each other
  // in observed evidence. This never reopens a terminal PostgreSQL recovery.
  return { kind: "accepted", effective: previously.ambiguity === "different-order-id"
    ? { ...incoming, ambiguity: previously.ambiguity } : incoming };
}

function validatedObservation(event: WooOrderCapture): WooStoredOrderObservation {
  if (!event.shopId || !event.checkoutKey || !event.order.orderId ||
      event.checkoutKey !== event.order.checkoutKey ||
      !KINDS[event.eventType] || !Number.isFinite(Date.parse(event.occurredAt))) {
    throw new Error("woo-order-event-invalid");
  }
  return {
    kind: KINDS[event.eventType],
    eventId: event.eventId,
    orderId: event.order.orderId,
    occurredAt: event.occurredAt,
  };
}

function recordedOrderId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).orderId;
  return typeof value === "string" ? value : null;
}

type TransitionOutcome =
  | { kind: "absent" }
  | { kind: "already-terminal"; recoveryId: string; status: string }
  | { kind: "changed"; recoveryId: string };

/**
 * BG002 order policy. A missing BullMQ candidate is deliberately irrelevant to
 * the PostgreSQL lookup. All four services must use the *same* coordinator
 * instance at BG005 composition; worker wiring is not part of this module.
 */
export class WooOrderReconciliationService implements WooOrderReconciler {
  constructor(
    private readonly database: ReconciliationDatabase,
    private readonly candidates: WooCandidateManager,
    private readonly coordinator: WooCheckoutCoordinator,
    private readonly evidence: WooOrderEvidenceStore,
    private readonly logger: StructuredLogger,
  ) {}

  async reconcileOrder(event: WooOrderCapture): Promise<WooOrderReconciliationOutcome> {
    let stage = "validation";
    let verifiedOrderId: string | undefined;
    try {
      const observation = validatedObservation(event);
      verifiedOrderId = observation.orderId;
      const ref: WooCheckoutRef = { shopId: event.shopId, checkoutToken: event.checkoutKey };
      stage = "coordination";
      const outcome = await this.coordinator.withCheckoutLock(ref, async () => {
        stage = "evidence-read";
        const previous = await this.evidence.inspect(ref);

        // Independent of candidate/job presence, including after a completed
        // maturity job has been removed. Durable recorded order IDs outlive
        // the bounded Redis observation, and cannot be cross-correlated.
        stage = "recovery-lookup";
        const durable = await this.database.checkoutRecovery.findFirst({
          where: { shopId: ref.shopId, checkoutToken: ref.checkoutToken },
          orderBy: [{ generation: "desc" }, { id: "desc" }],
          select: { id: true },
        });
        if (durable) {
          const history = await this.database.checkoutRecoveryStatusHistory.findFirst({
            where: { checkoutRecoveryId: durable.id, source: "woocommerce.order" },
            orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
            select: { metadata: true },
          });
          const previousOrderId = recordedOrderId(history?.metadata);
          if (previousOrderId !== null && previousOrderId !== observation.orderId) {
            return { kind: "deferred-conflict", reason: "recorded-order-id-conflict" } as const;
          }
        }

        const decision = decide(previous, observation);
        stage = "evidence-write";
        // Persist (or refresh) the suppression fence *before* removing the
        // candidate. A subsequent retry must repair an interrupted DB update.
        // Even a conflicting callback retains the previous safe observation.
        if (decision.kind !== "deferred-conflict" || previous !== null) {
          await this.evidence.persist(ref, decision.effective);
        }

        stage = "candidate-cancel";
        await this.candidates.cancelPending(ref);

        stage = "recovery-transition";
        const transition = await this.transitionRecovery(ref, decision.effective);
        if (decision.kind !== "accepted") {
          return { kind: decision.kind, reason: decision.reason } as const;
        }
        if (transition.kind === "already-terminal") {
          return { kind: "already-terminal", reason: `recovery-${transition.status.toLowerCase()}` } as const;
        }
        const kind = {
          "order-placed": "placed-suppressed",
          "order-paid": "paid-terminal",
          "order-cancelled": "cancelled-terminal",
        } as const;
        return {
          kind: kind[decision.effective.kind],
          ...(transition.kind === "changed" ? { recoveryId: transition.recoveryId } : {}),
        } as const;
      });
      const fields = {
        shopId: event.shopId, eventId: event.eventId, orderId: verifiedOrderId,
        operation: event.eventType, outcome: outcome.kind,
        ...( "reason" in outcome ? { reason: outcome.reason } : {}),
      };
      if (outcome.kind === "deferred-conflict") {
        this.logger.warn("woocommerce.recovery.order.deferred", fields);
      } else {
        this.logger.info("woocommerce.recovery.order.reconciled", fields);
      }
      return outcome;
    } catch (error) {
      this.logger.error("woocommerce.recovery.order.failed", {
        shopId: event.shopId,
        eventId: event.eventId,
        ...(verifiedOrderId ? { orderId: verifiedOrderId } : {}),
        operation: event.eventType,
        stage,
        reason: "dependency-or-validation-failure",
        errorName: error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
          ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : String(error),
        error: error,
      });
      throw error;
    }
  }

  private async transitionRecovery(
    ref: WooCheckoutRef,
    observation: WooStoredOrderObservation,
  ): Promise<TransitionOutcome> {
    return this.database.$transaction(async (tx) => {
      const recovery = await tx.checkoutRecovery.findFirst({
        where: { shopId: ref.shopId, checkoutToken: ref.checkoutToken },
        orderBy: [{ generation: "desc" }, { id: "desc" }],
        select: { id: true, status: true },
      });
      if (!recovery) return { kind: "absent" } as const;
      if (["COMPLETED", "EXPIRED", "CANCELLED"].includes(recovery.status)) {
        return { kind: "already-terminal", recoveryId: recovery.id, status: recovery.status } as const;
      }
      const toStatus = observation.kind === "order-paid" ? "COMPLETED" : "CANCELLED";
      const when = new Date(observation.occurredAt);
      const update = await tx.checkoutRecovery.updateMany({
        where: {
          id: recovery.id,
          shopId: ref.shopId,
          checkoutToken: ref.checkoutToken,
          status: recovery.status,
        },
        data: {
          status: toStatus,
          ...(toStatus === "COMPLETED" ? { completedAt: when } : { expiredAt: when }),
          admissionBlockedAt: null,
          admissionBlockReason: null,
        },
      });
      if (update.count !== 1) {
        // CAS failure is not a confirmed safe defer: another writer may have
        // moved DETECTED -> MESSAGE_SENT. Force BullMQ retry so the committed
        // status is re-read and terminalized before acknowledging the event.
        throw new Error("woo-recovery-transition-concurrent-update");
      }
      await tx.checkoutRecoveryStatusHistory.create({
        data: {
          checkoutRecoveryId: recovery.id,
          fromStatus: recovery.status,
          toStatus,
          reason: `woo-${observation.kind}`,
          source: "woocommerce.order",
          metadata: {
            orderId: observation.orderId, eventId: observation.eventId,
            orderKind: observation.kind,
          },
          occurredAt: when,
        },
      });
      // Only unsent attempts are cancelled. Never undo a delivered first send
      // or alter its existing usage, credit reservation or billing provenance.
      await tx.recoveryOutreachAttempt.updateMany({
        where: {
          checkoutRecoveryId: recovery.id,
          sentAt: null,
          status: { in: ["PENDING", "WAITING_FOR_RESPONSE"] },
        },
        data: { status: "CANCELLED", closedAt: when },
      });
      return { kind: "changed", recoveryId: recovery.id } as const;
    });
  }
}
