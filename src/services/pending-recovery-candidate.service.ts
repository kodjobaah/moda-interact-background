import {
  EVALUATE_PENDING_RECOVERY_JOB,
  PENDING_RECOVERY_CANDIDATE_QUEUE,
  type PendingRecoveryCandidate,
} from "../domain/pending-recovery-candidate.js";

import { Queue } from "bullmq";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";

import { connectionRedis } from "../lib/redis.js";
import type { CheckoutCreatedContractInput } from "../events/shopify-contract-adapter.js";
import { createPendingRecoveryCandidateJobId } from "@modainteract/moda-interact-shared/shopify/node";
import type { InternationalContext } from "@modainteract/moda-interact-shared/internationalization";
import {
  shopExecutionEligibilityService,
} from "./shop-execution-eligibility.service.js";
import { recoveryPolicyService } from "./recovery-policy.service.js";
import {
  PendingRecoveryCandidateIndexStore,
} from "./pending-recovery-candidate/candidate-index.store.js";
import {
  CheckoutOrderGuardService,
} from "./pending-recovery-candidate/checkout-order-guard.service.js";
import {
  PendingRecoveryCandidateLifecycleService,
} from "./pending-recovery-candidate/candidate-lifecycle.service.js";
import {
  PendingRecoveryCandidateActivityService,
  type CandidateActivityInput,
  type CandidateActivityResult,
} from "./pending-recovery-candidate/candidate-activity.service.js";
import {
  candidateActivityDueAtMs,
  canonicalCandidateActivityAt,
  maxCandidateActivityAt,
  mergeCandidateInternationalContext,
  optionalCandidateInternationalContext,
} from "./pending-recovery-candidate/candidate-activity.js";

const bullMQTelemetry = createBullMQTelemetry({
  serviceName: "moda-shopify-event-worker",
});

type CandidateEnqueueOutcome =
  | "enqueued"
  | "refreshed"
  | "discarded-shop-unavailable"
  | "discarded-subscription-frozen";

export type { CandidateActivityInput, CandidateActivityResult };

let pendingCandidateQueue: Queue<PendingRecoveryCandidate, void, string> | null =
  null;

function getPendingCandidateQueue() {
  if (!pendingCandidateQueue) {
    pendingCandidateQueue = new Queue(PENDING_RECOVERY_CANDIDATE_QUEUE, {
      connection: connectionRedis,
      telemetry: bullMQTelemetry,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 1_000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });
  }

  return pendingCandidateQueue;
}

export async function resetPendingCandidateQueueForTests() {
  await pendingCandidateQueue?.close();
  pendingCandidateQueue = null;
}

export class PendingRecoveryCandidateService {
  private readonly candidateLifecycleService: PendingRecoveryCandidateLifecycleService;
  private readonly candidateActivityService: PendingRecoveryCandidateActivityService;

  constructor(
    private readonly candidateIndexStore = new PendingRecoveryCandidateIndexStore(),
    private readonly checkoutOrderGuard = new CheckoutOrderGuardService(),
  ) {
    this.candidateLifecycleService = new PendingRecoveryCandidateLifecycleService({
      getQueue: () => getPendingCandidateQueue(),
      candidateIndexStore: this.candidateIndexStore,
      withCheckoutLock: (shopId, checkoutToken, callback) =>
        this.checkoutOrderGuard.withCheckoutLock(shopId, checkoutToken, callback),
    });
    this.candidateActivityService = new PendingRecoveryCandidateActivityService({
      resolveCandidate: (input) => this.candidateLifecycleService.resolve(input),
      withCheckoutLock: (shopId, checkoutToken, callback) =>
        this.checkoutOrderGuard.withCheckoutLock(shopId, checkoutToken, callback),
      cancelCandidate: (candidate) => this.candidateLifecycleService.cancel(candidate),
      resolveDelayMinutes: async (shopId) =>
        (await recoveryPolicyService.resolve(shopId)).recoveryDelayMinutes,
      getQueue: () => getPendingCandidateQueue(),
      candidateIndexStore: this.candidateIndexStore,
    });
  }

  async scheduleFromCheckoutCreated(input: CheckoutCreatedContractInput): Promise<
    | {
        outcome: "enqueued" | "refreshed";
        jobId: string;
        delayMinutes: number;
        candidate: PendingRecoveryCandidate;
      }
    | {
        outcome: "discarded-shop-unavailable";
        shopDomain: string;
        reason?: "CONTRACT_REQUIRED" | "SUBSCRIPTION_FROZEN" | "SHOP_UNAVAILABLE" | "UNMAPPED_PLAN" | "SYNC_ERROR";
      }
    | { outcome: "discarded-subscription-frozen"; shopDomain: string }
  > {
    const shopDomain = input.shopDomain.trim().toLowerCase();
    const shop = await shopExecutionEligibilityService.resolveShopByDomain(shopDomain);

    if (!shop) {
      throw new Error(`Shop not found for domain: ${shopDomain}`);
    }
    if (shop.status !== "ACTIVE") {
      return { outcome: "discarded-shop-unavailable", shopDomain };
    }
    const execution = shopExecutionEligibilityService.evaluateResolvedShop(
      shop,
      "recovery",
    );
    if (!execution.allowed) {
      if (execution.reason === "SUBSCRIPTION_FROZEN") {
        return { outcome: "discarded-subscription-frozen", shopDomain };
      }
      return {
        outcome: "discarded-shop-unavailable",
        shopDomain,
        reason: execution.reason,
      };
    }

    const policy = await recoveryPolicyService.resolve(shop.id);
    const delayMinutes = policy.recoveryDelayMinutes;
    const schedulingNow = Date.now();

    const candidate: PendingRecoveryCandidate = {
      shopId: shop.id,
      shopDomain,
      checkoutToken: input.checkoutToken,
      cartToken: input.cartToken,
      abandonedCheckoutUrl: input.abandonedCheckoutUrl,
      checkoutCreatedAt: input.checkoutCreatedAt,
      ...(input.internationalContext
        ? { internationalContext: input.internationalContext }
        : {}),
      lastActivityAt: canonicalCandidateActivityAt(input.activityAt, schedulingNow),
    };

    const queue = getPendingCandidateQueue();
    const legacyJobId = createPendingRecoveryCandidateJobId(
      candidate.shopId,
      candidate.checkoutToken,
    );
    const jobId = `${candidate.shopId}--${legacyJobId}`;

    const [newJob, legacyJob] = await Promise.all([
      queue.getJob(jobId),
      queue.getJob(legacyJobId),
    ]);
    const existingJob = newJob ?? legacyJob;
    const activeJobId = newJob ? jobId : legacyJob ? legacyJobId : jobId;
    if (existingJob) {
      const previousCartToken = existingJob.data.cartToken;
      const effectiveLastActivityAt = maxCandidateActivityAt(
        existingJob.data.lastActivityAt ?? existingJob.data.checkoutCreatedAt,
        candidate.lastActivityAt,
      );
      const effectiveCandidate = {
        ...candidate,
        ...optionalCandidateInternationalContext(
          mergeCandidateInternationalContext(
            existingJob.data.internationalContext,
            candidate.internationalContext,
          ),
        ),
        lastActivityAt: effectiveLastActivityAt,
      };
      if (newJob && legacyJob) {
        await legacyJob.remove();
        await this.candidateIndexStore.removeShopMember(candidate.shopId, legacyJobId);
      }
      if (
        previousCartToken &&
        previousCartToken !== effectiveCandidate.cartToken
      ) {
        await this.candidateIndexStore.removeCartAlias(candidate.shopId, previousCartToken);
      }
      await existingJob.updateData(effectiveCandidate);
      const state = await existingJob.getState();
      if (state === "delayed") {
        const dueAtMs = candidateActivityDueAtMs(effectiveLastActivityAt, delayMinutes);
        await existingJob.changeDelay(Math.max(0, dueAtMs - Date.now()));
      }

      await this.candidateIndexStore.upsert({
        candidate: effectiveCandidate,
        jobId: activeJobId,
        delayMinutes,
        dueAtMs: state === "delayed"
          ? candidateActivityDueAtMs(effectiveLastActivityAt, delayMinutes)
          : Date.now(),
        shouldIndexShop:
          state === "delayed" || state === "waiting" || state === "active",
      });

      return {
        outcome: "refreshed",
        jobId: activeJobId,
        delayMinutes,
        candidate: effectiveCandidate,
      };
    }

    const dueAtMs = candidateActivityDueAtMs(candidate.lastActivityAt, delayMinutes);
    await queue.add(EVALUATE_PENDING_RECOVERY_JOB, candidate, {
      jobId,
      delay: Math.max(0, dueAtMs - schedulingNow),
    });

    await this.candidateIndexStore.upsert({
      candidate,
      jobId,
      delayMinutes,
      dueAtMs,
      shouldIndexShop: true,
    });

    return {
      outcome: "enqueued",
      jobId,
      delayMinutes,
      candidate,
    };
  }

  async scheduleFromCheckoutUpdated(input: {
    shopDomain: string;
    checkoutToken: string;
    cartToken: string | null;
    checkoutCreatedAt: string | null;
    abandonedCheckoutUrl: string | null;
    activityAt: string;
    internationalContext?: InternationalContext;
  }) {
    return this.scheduleFromCheckoutCreated(input);
  }

  async findCandidateJobIdByCheckout(input: {
    shopId: string;
    checkoutToken: string;
  }) {
    return this.candidateLifecycleService.findByCheckout(input);
  }

  async findCandidateJobIdByCart(input: { shopId: string; cartToken: string }) {
    return this.candidateLifecycleService.findByCart(input);
  }

  async refreshCandidateActivity(
    input: CandidateActivityInput,
  ): Promise<CandidateActivityResult> {
    return this.candidateActivityService.refresh(input);
  }

  async cancelCandidateByCart(input: {
    shopId: string;
    cartToken: string;
  }): Promise<
    | { outcome: "cancelled"; jobId: string }
    | { outcome: "not-found" }
    | { outcome: "not-reschedulable"; state: string; jobId: string }
  > {
    return this.candidateLifecycleService.cancelByCart(input);
  }

  async cancelCandidateByCheckout(input: {
    shopId: string;
    checkoutToken: string;
  }) {
    return this.candidateLifecycleService.cancelByCheckout(input);
  }

  /**
   * Resolve a pending candidate by checkout token, falling back to the
   * indexed cart-token correlation only when the checkout token is missing.
   *
   * ARCH-001-BACKGROUND-005. Both lookups are O(1) Redis index reads; no
   * BullMQ queue scan is performed. This lets the order path correlate an
   * order with a pending recovery candidate without scanning jobs.
   */
  async resolveCandidate(input: {
    shopId: string;
    checkoutToken: string | null;
    cartToken: string | null;
  }): Promise<{ jobId: string; candidate: PendingRecoveryCandidate } | null> {
    return this.candidateLifecycleService.resolve(input);
  }

  /**
   * Cancel a resolved pending candidate: remove the delayed BullMQ job and all
   * of its transient correlation aliases (checkout and cart indexes).
   */
  async cancelCandidate(input: {
    jobId: string;
    candidate: PendingRecoveryCandidate;
  }): Promise<{ removed: true }> {
    return this.candidateLifecycleService.cancel(input);
  }

  /**
   * Serialise a callback on a single checkout. Both the order path and the
   * candidate materialization path acquire this checkout-scoped mutex so an
   * order completing a checkout cannot race a recovery message for it.
   */
  async withCheckoutLock<T>(
    shopId: string,
    checkoutToken: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.checkoutOrderGuard.withCheckoutLock(shopId, checkoutToken, fn);
  }

  /**
   * Record that an order for a checkout has been processed. The candidate
   * materialization path reads this to suppress an inappropriate recovery
   * message when the order completed the checkout first.
   */
  async markOrderProcessed(shopId: string, checkoutToken: string) {
    await this.checkoutOrderGuard.markOrderProcessed(shopId, checkoutToken);
  }

  /**
   * True when an order for the checkout has already been processed. Used by the
   * materialization path as a checkout-scoped guard before creating a recovery.
   */
  async hasOrderProcessed(shopId: string, checkoutToken: string) {
    return this.checkoutOrderGuard.hasOrderProcessed(shopId, checkoutToken);
  }


  async handleCandidateMatured(
    candidate: PendingRecoveryCandidate,
    jobId?: string,
  ) {
    await this.candidateIndexStore.remove(candidate, jobId);
    return candidate;
  }


}

export const pendingRecoveryCandidateService =
  new PendingRecoveryCandidateService();

