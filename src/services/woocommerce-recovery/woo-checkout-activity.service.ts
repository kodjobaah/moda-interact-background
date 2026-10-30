import { createHash } from "node:crypto";
import { createLogger } from "@modainteract/moda-interact-shared/logging";

import type { WooCheckoutCapture } from "../../events/woo-checkout-capture.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import type {
  WooBasketEvidence,
  WooCheckoutActivityHandler,
  WooCheckoutActivityOutcome,
  WooCheckoutCoordinator,
  WooCheckoutRef,
  WooObservedOrderStateReader,
  WooPendingCandidate,
} from "./contracts.js";
import {
  WooPendingCandidateQueueService,
  type WooCandidateScheduler,
} from "./woo-candidate-queue.service.js";
import {
  WooActivityWatermarkStore,
  wooCandidateRetentionMs,
  type WooActivityWatermark,
  type WooActivityWatermarkPort,
} from "./woo-activity-watermark.store.js";
import {
  WooExistingRecoveryRepository,
  WooShopEligibilityRepository,
  type WooLatestRecovery,
} from "./woo-checkout-activity.adapters.js";
import { recoveryPolicyService } from "../recovery-policy.service.js";

export interface WooRecoveryLookupPort {
  findExisting(ref: WooCheckoutRef): Promise<WooLatestRecovery | null>;
  recordExternalActivity(ref: WooCheckoutRef, recoveryId: string, occurredAt: Date): Promise<void>;
  closeForResumption(input: { ref: WooCheckoutRef; recovery: WooLatestRecovery; occurredAt: Date;
    eventId: string; nextGeneration: number }): Promise<boolean>;
}

export interface WooShopEligibilityPort {
  evaluate(shopId: string): Promise<{ allowed: true; shopDomain: string } | { allowed: false; reason: string }>;
}

export type WooCheckoutActivityDependencies = Readonly<{
  coordinator: WooCheckoutCoordinator;
  observedOrders: WooObservedOrderStateReader;
  candidates: WooCandidateScheduler;
  watermarks: WooActivityWatermarkPort;
  recoveries: WooRecoveryLookupPort;
  shops: WooShopEligibilityPort;
  resolveDelayMinutes(shopId: string): Promise<number>;
  now?: () => number;
  logOutcome?: (shopId: string, outcome: WooCheckoutActivityOutcome) => void;
  logFailure?: (fields: { shopId: string; eventHash: string; stage: string; reason: string }) => void;
}>;

function checkoutDigest(checkout: WooCheckoutCapture["checkout"]): string {
  return createHash("sha256").update(JSON.stringify(checkout)).digest("hex");
}

type WatermarkOrdering = "clear" | "stale" | "duplicate" | "conflict";

function classifyWatermark(
  watermark: WooActivityWatermark,
  event: WooCheckoutCapture,
  digest: string,
): WatermarkOrdering {
  const eventMs = Date.parse(event.occurredAt);
  const watermarkMs = Date.parse(watermark.lastActivityAt);
  if (!Number.isFinite(watermarkMs)) return "conflict";
  const eventSecond = Math.floor(eventMs / 1_000);
  const watermarkSecond = Math.floor(watermarkMs / 1_000);
  if (watermark.lastEventId === event.eventId) {
    return watermark.state !== "conflicting" && watermark.lastActivityAt === event.occurredAt &&
      watermark.checkoutDigest === digest ? "duplicate" : "conflict";
  }
  if (eventSecond < watermarkSecond) return "stale";
  if (eventSecond === watermarkSecond) {
    return "conflict";
  }
  return "clear";
}

/** Events with omitted/over-limit items must not reuse an older complete basket. */
function basketFrom(event: WooCheckoutCapture): WooBasketEvidence {
  const items = event.checkout.items;
  if (!items || items.length > 50) return { kind: "unknown", reason: "items-omitted" };
  if (items.length === 0) return { kind: "empty" };
  const [first, ...rest] = items;
  if (!first) return { kind: "unknown", reason: "incomplete-snapshot" };
  return {
    kind: "nonempty",
    checkout: { ...event.checkout, items: [first, ...rest] },
  };
}

function candidateWatermark(candidate: WooPendingCandidate): WooActivityWatermark {
  if (!Number.isSafeInteger(candidate.generation) || (candidate.generation ?? 0) < 1) {
    throw new Error("Invalid Woo candidate generation");
  }
  return {
    generation: candidate.generation!,
    lastEventId: candidate.lastEventId,
    lastActivityAt: candidate.lastActivityAt,
    checkoutDigest: candidate.basket.kind === "nonempty"
      ? checkoutDigest(candidate.basket.checkout)
      : "0".repeat(64),
    state: candidate.basket.kind === "nonempty" ? "nonempty" : candidate.basket.kind,
  };
}

/** No event can authorize outreach; this service only manages the mature-candidate
 * queue. All decisions are made within BG002's injected checkout coordinator. */
export class WooCheckoutActivityService implements WooCheckoutActivityHandler {
  private readonly now: () => number;

  constructor(private readonly deps: WooCheckoutActivityDependencies) {
    this.now = deps.now ?? Date.now;
  }

  async handleCheckout(event: WooCheckoutCapture): Promise<WooCheckoutActivityOutcome> {
    // Only the authenticated Background capture projection supplies shopId.
    // This service never resolves a tenant from checkoutKey, contact or domain.
    const ref: WooCheckoutRef = { shopId: event.shopId, checkoutToken: event.checkoutKey };
    try {
      const result = await this.deps.coordinator.withCheckoutLock(ref, () => this.evaluate(ref, event));
      this.deps.logOutcome?.(ref.shopId, result);
      return result;
    } catch (error) {
      this.deps.logFailure?.({
        shopId: ref.shopId,
        eventHash: createHash("sha256").update(event.eventId).digest("hex").slice(0, 16),
        stage: "checkout_activity",
        reason: error instanceof Error ? error.name.slice(0, 48) : "unknown_error",
      });
      throw error;
    }
  }

  private async evaluate(
    ref: WooCheckoutRef,
    event: WooCheckoutCapture,
  ): Promise<WooCheckoutActivityOutcome> {
    const occurredMs = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurredMs)) throw new Error("Invalid authenticated Woo event timestamp");
    const incomingDigest = checkoutDigest(event.checkout);
    // Keep this pre-close watermark separately. A successor-generation
    // watermark may be ignored by candidate reconciliation below, but it must
    // still fence a stale/conflicting event from closing an active recovery.
    const boundaryWatermark = await this.deps.watermarks.read(ref);

    // PostgreSQL is authoritative even when a maturity job disappeared. The
    // latest generation and its bounded origin/resumption evidence define the
    // durable event boundary; Redis is only a repairable candidate cache.
    const existing = await this.deps.recoveries.findExisting(ref);
    let generation = 1;
    let resumed: { previousRecoveryId: string; nextGeneration: number } | null = null;
    let exactResumptionReplay = false;
    if (existing) {
      if (existing.status === "DETECTED" && existing.admissionEventId === event.eventId) {
        return { kind: "repair-existing-initial", recoveryId: existing.id, generation: existing.generation };
      }
      if (existing.resumption) {
        generation = existing.resumption.nextGeneration;
        if (existing.resumption.eventId === event.eventId) {
          resumed = { previousRecoveryId: existing.id, nextGeneration: generation };
          exactResumptionReplay = true;
        }
      }
      if (!exactResumptionReplay && ["DETECTED", "MESSAGE_SENT", "ENGAGED"].includes(existing.status)) {
        if (boundaryWatermark) {
          const ordering = classifyWatermark(boundaryWatermark, event, incomingDigest);
          if (ordering === "stale") return { kind: "ignored-stale", reason: "older_than_activity_watermark" };
          if (ordering === "duplicate") return { kind: "ignored-stale", reason: "duplicate_event" };
          if (ordering === "conflict") {
            await this.deps.candidates.cancelPending(ref, existing.generation + 1);
            return { kind: "deferred-ambiguous", reason: "activity_watermark_conflict" };
          }
          if (boundaryWatermark.generation !== existing.generation) {
            return { kind: "deferred-ambiguous", reason: "activity_watermark_generation_mismatch" };
          }
        }
      }
      if (exactResumptionReplay && boundaryWatermark) {
        const ordering = classifyWatermark(boundaryWatermark, event, incomingDigest);
        if (ordering === "stale") {
          // A later successor update is already durable in Redis. The replay is
          // acknowledged for old-generation cleanup but must not rewrite it.
          return { kind: "resumed", previousRecoveryId: existing.id,
            nextGeneration: generation, candidateOutcome: "rescheduled" };
        }
        if (ordering === "conflict") {
          return { kind: "resumed", previousRecoveryId: existing.id,
            nextGeneration: generation, candidateOutcome: "deferred-ambiguous" };
        }
      }
      if (!exactResumptionReplay) {
        const durableMs = existing.lastExternalActivityAt.getTime();
        const incomingSecond = Math.floor(occurredMs / 1_000);
        const durableSecond = Math.floor(durableMs / 1_000);
        if (incomingSecond < durableSecond) return { kind: "ignored-stale", reason: "older_than_durable_recovery" };
        if (incomingSecond === durableSecond) {
          await this.deps.candidates.cancelPending(ref, existing.resumption?.nextGeneration ?? existing.generation + 1);
          if (resumed) return { kind: "resumed", ...resumed, candidateOutcome: "deferred-ambiguous" };
          return { kind: "deferred-ambiguous", reason: "same_time_recovery_boundary" };
        }
        if (["DETECTED", "MESSAGE_SENT", "ENGAGED"].includes(existing.status)) {
          generation = existing.generation + 1;
          const closed = await this.deps.recoveries.closeForResumption({
            ref, recovery: existing, occurredAt: new Date(occurredMs), eventId: event.eventId,
            nextGeneration: generation,
          });
          // A failed CAS means another writer won. Retry the captured event so
          // it is re-read against the committed durable state.
          if (!closed) throw new Error("Woo recovery resumption compare-and-set lost");
          resumed = { previousRecoveryId: existing.id, nextGeneration: generation };
        } else if (existing.status === "CANCELLED" && existing.resumption) {
          generation = existing.resumption.nextGeneration;
        } else if (existing.status === "EXPIRED") {
          generation = existing.generation + 1;
        } else {
          await this.deps.candidates.cancelPending(ref, existing.generation);
          return { kind: "ignored-terminal", reason: existing.status.toLowerCase() };
        }
      }
    }

    const observed = await this.deps.observedOrders.read(ref);
    if (observed.kind !== "none-observed") {
      await this.deps.candidates.cancelPending(ref, generation);
      return observed.kind === "ambiguous"
        ? { kind: "deferred-ambiguous", reason: "order_observation_ambiguous" }
        : { kind: "ignored-terminal", reason: observed.kind };
    }

    const shop = await this.deps.shops.evaluate(ref.shopId);
    if (!shop.allowed) {
      await this.deps.candidates.cancelPending(ref, generation);
      return { kind: "not-eligible", reason: shop.reason };
    }
    // shop.shopDomain is always read from the persisted Shop, not the event;
    // the Woo candidate has no Shopify/restore URL or untrusted domain field.

    const delayMinutes = await this.deps.resolveDelayMinutes(ref.shopId);
    if (!Number.isSafeInteger(delayMinutes) || delayMinutes < 1) {
      await this.deps.candidates.cancelPending(ref, generation);
      return { kind: "not-eligible", reason: "invalid_recovery_delay" };
    }
    const now = this.now();
    const dueAtMs = occurredMs + delayMinutes * 60_000;
    const retentionMs = wooCandidateRetentionMs(dueAtMs, now);
    if (retentionMs === null || occurredMs > now + 5 * 60_000) {
      await this.deps.candidates.cancelPending(ref, generation);
      return { kind: "deferred-ambiguous", reason: "timestamp_outside_safe_horizon" };
    }

    let watermark = boundaryWatermark;
    if (watermark && watermark.generation !== generation) watermark = null;
    const pending = await this.deps.candidates.getPending(ref, generation);
    if (pending) {
      const pendingAt = Date.parse(pending.lastActivityAt);
      if (!Number.isFinite(pendingAt)) throw new Error("Invalid Woo candidate timestamp");
      if (exactResumptionReplay) {
        const pendingSecond = Math.floor(pendingAt / 1_000);
        const replaySecond = Math.floor(occurredMs / 1_000);
        if (pendingSecond > replaySecond) {
          return { kind: "resumed", previousRecoveryId: resumed!.previousRecoveryId,
            nextGeneration: generation, candidateOutcome: "rescheduled" };
        }
        if (pendingSecond === replaySecond && !(pending.lastEventId === event.eventId &&
          pending.lastActivityAt === event.occurredAt && pending.basket.kind === "nonempty" &&
          checkoutDigest(pending.basket.checkout) === incomingDigest)) {
          return { kind: "resumed", previousRecoveryId: resumed!.previousRecoveryId,
            nextGeneration: generation, candidateOutcome: "deferred-ambiguous" };
        }
        if (pending.lastEventId === event.eventId && pending.basket.kind === "nonempty" &&
          checkoutDigest(pending.basket.checkout) !== incomingDigest) {
          return { kind: "resumed", previousRecoveryId: resumed!.previousRecoveryId,
            nextGeneration: generation, candidateOutcome: "deferred-ambiguous" };
        }
      }
      // The queue update may have succeeded while the index or watermark
      // failed. A replay of that very event must repair BOTH, not just mark
      // it a duplicate and strand an unindexed maturity job.
      if ((exactResumptionReplay || !watermark || pendingAt > Date.parse(watermark.lastActivityAt)) &&
        pendingAt === occurredMs && pending.lastEventId === event.eventId &&
        pending.basket.kind === "nonempty" &&
        checkoutDigest(pending.basket.checkout) === incomingDigest) {
        const outcome = await this.deps.candidates.schedulePending({
          candidate: pending, delayMinutes, dueAtMs, retentionMs,
        });
        await this.deps.watermarks.write(ref, candidateWatermark(pending), retentionMs);
        return resumed
          ? { kind: "resumed", ...resumed, candidateOutcome: outcome, dueAt: new Date(dueAtMs).toISOString() }
          : { kind: outcome, dueAt: new Date(dueAtMs).toISOString(), generation };
      }
      if (!watermark || pendingAt > Date.parse(watermark.lastActivityAt)) {
        watermark = candidateWatermark(pending);
        await this.deps.watermarks.write(ref, watermark, retentionMs);
      }
    }

    if (watermark && !exactResumptionReplay) {
      const acceptedMs = Date.parse(watermark.lastActivityAt);
      // Woo snapshots cannot be causally ordered at subsecond precision.
      // Different versions in the same source second must be quarantined.
      const incomingSecond = Math.floor(occurredMs / 1_000);
      const acceptedSecond = Math.floor(acceptedMs / 1_000);
      if (incomingSecond < acceptedSecond) return { kind: "ignored-stale", reason: "older_event" };
      if (incomingSecond === acceptedSecond) {
        if (watermark.state === "conflicting") {
          if (resumed) return { kind: "resumed", ...resumed, candidateOutcome: "deferred-ambiguous" };
          return { kind: "deferred-ambiguous", reason: "same_time_conflict" };
        }
        if (watermark.lastEventId === event.eventId &&
          watermark.lastActivityAt === event.occurredAt &&
          watermark.checkoutDigest === incomingDigest) {
          if (resumed) return { kind: "resumed", ...resumed, candidateOutcome: "scheduled" };
          return { kind: "ignored-stale", reason: "duplicate_event" };
        }
        // Source timestamps do not order two distinct same-time versions.
        // Invalidate the send-eligible candidate and keep the ambiguity marker.
        await this.deps.candidates.cancelPending(ref, generation);
        await this.deps.watermarks.write(ref, {
          generation,
          lastEventId: event.eventId,
          lastActivityAt: event.occurredAt,
          checkoutDigest: incomingDigest,
          state: "conflicting",
        }, retentionMs);
        return resumed
          ? { kind: "resumed", ...resumed, candidateOutcome: "deferred-ambiguous" }
          : { kind: "deferred-ambiguous", reason: "same_time_conflict" };
      }
      if (watermark.lastEventId === event.eventId) {
        // An eventId must not represent two distinct source revisions.
        await this.deps.candidates.cancelPending(ref, generation);
        await this.deps.watermarks.write(ref, {
          generation,
          lastEventId: event.eventId,
          lastActivityAt: event.occurredAt,
          checkoutDigest: incomingDigest,
          state: "conflicting",
        }, retentionMs);
        return resumed
          ? { kind: "resumed", ...resumed, candidateOutcome: "deferred-ambiguous" }
          : { kind: "deferred-ambiguous", reason: "event_id_reused" };
      }
    }

    const basket = basketFrom(event);
    if (basket.kind !== "nonempty") {
      // An empty or unknown *later* snapshot invalidates an older candidate.
      // Unknown is never proof of empty and never an admissible basket.
      await this.deps.candidates.cancelPending(ref, generation);
      await this.deps.watermarks.write(ref, {
        generation,
        lastEventId: event.eventId,
        lastActivityAt: event.occurredAt,
        checkoutDigest: incomingDigest,
        state: basket.kind,
      }, retentionMs);
      if (resumed) return { kind: "resumed", ...resumed,
        candidateOutcome: basket.kind === "empty" ? "cancelled-empty" : "deferred-ambiguous" };
      return basket.kind === "empty"
        ? { kind: "cancelled-empty", reason: "explicit_empty_basket" }
        : { kind: "deferred-ambiguous", reason: basket.reason };
    }

    const candidate: WooPendingCandidate = {
      source: "woocommerce",
      generation,
      shopId: ref.shopId,
      checkoutToken: ref.checkoutToken,
      lastEventId: event.eventId,
      lastActivityAt: event.occurredAt,
      basket,
    };
    const outcome = await this.deps.candidates.schedulePending({
      candidate, delayMinutes, dueAtMs, retentionMs,
    });
    // Publish the watermark last: a failed queue/index write can be retried
    // without accidentally treating an unenqueued candidate as a duplicate.
    await this.deps.watermarks.write(ref, {
      generation,
      lastEventId: event.eventId,
      lastActivityAt: event.occurredAt,
      checkoutDigest: incomingDigest,
      state: "nonempty",
    }, retentionMs);
    return resumed
      ? { kind: "resumed", ...resumed, candidateOutcome: outcome, dueAt: new Date(dueAtMs).toISOString() }
      : { kind: outcome, dueAt: new Date(dueAtMs).toISOString(), generation };
  }
}

/** BG005 is the only owner of worker wiring; this factory performs no wiring. */
export function createWooCheckoutActivityService(input: {
  coordinator: WooCheckoutCoordinator;
  observedOrders: WooObservedOrderStateReader;
  candidates?: WooCandidateScheduler;
}): WooCheckoutActivityService {
  const logger = createLogger({
    serviceName: "moda-shopify-event-worker",
    environment: resolveDeploymentEnvironmentName(),
  });
  return new WooCheckoutActivityService({
    coordinator: input.coordinator,
    observedOrders: input.observedOrders,
    candidates: input.candidates ?? new WooPendingCandidateQueueService(),
    watermarks: new WooActivityWatermarkStore(),
    recoveries: new WooExistingRecoveryRepository(),
    shops: new WooShopEligibilityRepository(),
    resolveDelayMinutes: async (shopId) =>
      (await recoveryPolicyService.resolve(shopId)).recoveryDelayMinutes,
    logOutcome: (shopId, outcome) => logger.info("woocommerce.checkout_activity.evaluated", {
      shopId,
      outcome: outcome.kind,
      // The payload, checkout key, recipient and source URL are intentionally omitted.
      ...("reason" in outcome ? { reason: outcome.reason } : {}),
    }),
    logFailure: (fields) => logger.error("woocommerce.checkout_activity.failed", fields),
  });
}
