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
} from "./woo-checkout-activity.adapters.js";
import { recoveryPolicyService } from "../recovery-policy.service.js";

type ExistingRecovery = Readonly<{ id: string }>;
export interface WooRecoveryLookupPort {
  findExisting(ref: WooCheckoutRef): Promise<ExistingRecovery | null>;
  recordExternalActivity(ref: WooCheckoutRef, recoveryId: string, occurredAt: Date): Promise<void>;
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
}>;

function checkoutDigest(checkout: WooCheckoutCapture["checkout"]): string {
  return createHash("sha256").update(JSON.stringify(checkout)).digest("hex");
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
  return {
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
    const result = await this.deps.coordinator.withCheckoutLock(ref, () => this.evaluate(ref, event));
    this.deps.logOutcome?.(ref.shopId, result);
    return result;
  }

  private async evaluate(
    ref: WooCheckoutRef,
    event: WooCheckoutCapture,
  ): Promise<WooCheckoutActivityOutcome> {
    const occurredMs = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurredMs)) throw new Error("Invalid authenticated Woo event timestamp");

    // PostgreSQL is authoritative even when the index/job was removed, completed
    // or failed. Recheck under the shared checkout lock before *any* scheduling.
    const existing = await this.deps.recoveries.findExisting(ref);
    if (existing) {
      await this.deps.recoveries.recordExternalActivity(ref, existing.id, new Date(occurredMs));
      await this.deps.candidates.cancelPending(ref);
      return { kind: "existing-recovery", recoveryId: existing.id };
    }

    const observed = await this.deps.observedOrders.read(ref);
    if (observed.kind !== "none-observed") {
      await this.deps.candidates.cancelPending(ref);
      return observed.kind === "ambiguous"
        ? { kind: "deferred-ambiguous", reason: "order_observation_ambiguous" }
        : { kind: "ignored-terminal", reason: observed.kind };
    }

    const shop = await this.deps.shops.evaluate(ref.shopId);
    if (!shop.allowed) {
      await this.deps.candidates.cancelPending(ref);
      return { kind: "not-eligible", reason: shop.reason };
    }
    // shop.shopDomain is always read from the persisted Shop, not the event;
    // the Woo candidate has no Shopify/restore URL or untrusted domain field.

    const delayMinutes = await this.deps.resolveDelayMinutes(ref.shopId);
    if (!Number.isSafeInteger(delayMinutes) || delayMinutes < 1) {
      await this.deps.candidates.cancelPending(ref);
      return { kind: "not-eligible", reason: "invalid_recovery_delay" };
    }
    const now = this.now();
    const dueAtMs = occurredMs + delayMinutes * 60_000;
    const retentionMs = wooCandidateRetentionMs(dueAtMs, now);
    if (retentionMs === null || occurredMs > now + 5 * 60_000) {
      await this.deps.candidates.cancelPending(ref);
      return { kind: "deferred-ambiguous", reason: "timestamp_outside_safe_horizon" };
    }

    const incomingDigest = checkoutDigest(event.checkout);
    let watermark = await this.deps.watermarks.read(ref);
    const pending = await this.deps.candidates.getPending(ref);
    if (pending) {
      const pendingAt = Date.parse(pending.lastActivityAt);
      if (!Number.isFinite(pendingAt)) throw new Error("Invalid Woo candidate timestamp");
      // The queue update may have succeeded while the index or watermark
      // failed. A replay of that very event must repair BOTH, not just mark
      // it a duplicate and strand an unindexed maturity job.
      if ((!watermark || pendingAt > Date.parse(watermark.lastActivityAt)) &&
        pendingAt === occurredMs && pending.lastEventId === event.eventId &&
        pending.basket.kind === "nonempty" &&
        checkoutDigest(pending.basket.checkout) === incomingDigest) {
        const outcome = await this.deps.candidates.schedulePending({
          candidate: pending, delayMinutes, dueAtMs, retentionMs,
        });
        await this.deps.watermarks.write(ref, candidateWatermark(pending), retentionMs);
        return { kind: outcome, dueAt: new Date(dueAtMs).toISOString() };
      }
      if (!watermark || pendingAt > Date.parse(watermark.lastActivityAt)) {
        watermark = candidateWatermark(pending);
        await this.deps.watermarks.write(ref, watermark, retentionMs);
      }
    }

    if (watermark) {
      const acceptedMs = Date.parse(watermark.lastActivityAt);
      // Woo snapshots cannot be causally ordered at subsecond precision.
      // Different versions in the same source second must be quarantined.
      const incomingSecond = Math.floor(occurredMs / 1_000);
      const acceptedSecond = Math.floor(acceptedMs / 1_000);
      if (incomingSecond < acceptedSecond) return { kind: "ignored-stale", reason: "older_event" };
      if (incomingSecond === acceptedSecond) {
        if (watermark.state === "conflicting") {
          return { kind: "deferred-ambiguous", reason: "same_time_conflict" };
        }
        if (watermark.lastEventId === event.eventId &&
          watermark.lastActivityAt === event.occurredAt &&
          watermark.checkoutDigest === incomingDigest) {
          return { kind: "ignored-stale", reason: "duplicate_event" };
        }
        // Source timestamps do not order two distinct same-time versions.
        // Invalidate the send-eligible candidate and keep the ambiguity marker.
        await this.deps.candidates.cancelPending(ref);
        await this.deps.watermarks.write(ref, {
          lastEventId: event.eventId,
          lastActivityAt: event.occurredAt,
          checkoutDigest: incomingDigest,
          state: "conflicting",
        }, retentionMs);
        return { kind: "deferred-ambiguous", reason: "same_time_conflict" };
      }
      if (watermark.lastEventId === event.eventId) {
        // An eventId must not represent two distinct source revisions.
        await this.deps.candidates.cancelPending(ref);
        await this.deps.watermarks.write(ref, {
          lastEventId: event.eventId,
          lastActivityAt: event.occurredAt,
          checkoutDigest: incomingDigest,
          state: "conflicting",
        }, retentionMs);
        return { kind: "deferred-ambiguous", reason: "event_id_reused" };
      }
    }

    const basket = basketFrom(event);
    if (basket.kind !== "nonempty") {
      // An empty or unknown *later* snapshot invalidates an older candidate.
      // Unknown is never proof of empty and never an admissible basket.
      await this.deps.candidates.cancelPending(ref);
      await this.deps.watermarks.write(ref, {
        lastEventId: event.eventId,
        lastActivityAt: event.occurredAt,
        checkoutDigest: incomingDigest,
        state: basket.kind,
      }, retentionMs);
      return basket.kind === "empty"
        ? { kind: "cancelled-empty", reason: "explicit_empty_basket" }
        : { kind: "deferred-ambiguous", reason: basket.reason };
    }

    const candidate: WooPendingCandidate = {
      source: "woocommerce",
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
      lastEventId: event.eventId,
      lastActivityAt: event.occurredAt,
      checkoutDigest: incomingDigest,
      state: "nonempty",
    }, retentionMs);
    return { kind: outcome, dueAt: new Date(dueAtMs).toISOString() };
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
  });
}
