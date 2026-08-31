import {
  DEFAULT_RECOVERY_DELAY_MINUTES,
  EVALUATE_PENDING_RECOVERY_JOB,
  PENDING_RECOVERY_CANDIDATE_QUEUE,
  checkoutOrderCompletedKey,
  checkoutOrderLockKey,
  pendingCandidateCartIndexKey,
  pendingCandidateCheckoutIndexKey,
  pendingCandidateIndexTtlMs,
  type PendingRecoveryCandidate,
} from "../domain/pending-recovery-candidate.js";

const CHECKOUT_LOCK_TTL_MS = 10_000;
const CHECKOUT_LOCK_RETRIES = 30;
const CHECKOUT_LOCK_RETRY_DELAY_MS = 100;
const ORDER_COMPLETED_TOMBSTONE_TTL_MS = 60 * 60 * 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { Queue } from "bullmq";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";

import prisma from "../lib/db.js";
import { connectionRedis } from "../lib/redis.js";
import type { CheckoutCreatedContractInput } from "../events/shopify-contract-adapter.js";
import { createPendingRecoveryCandidateJobId } from "@modainteract/moda-interact-shared/shopify/node";

const bullMQTelemetry = createBullMQTelemetry({
  serviceName: "moda-shopify-event-worker",
});

type CandidateEnqueueOutcome = "enqueued" | "refreshed";

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
  async scheduleFromCheckoutCreated(input: CheckoutCreatedContractInput): Promise<{
    outcome: CandidateEnqueueOutcome;
    jobId: string;
    delayMinutes: number;
    candidate: PendingRecoveryCandidate;
  }> {
    const shop = await prisma.shop.findUnique({
      where: {
        domain: input.shopDomain,
      },
      select: {
        id: true,
        settings: {
          select: {
            recoveryDelayMinutes: true,
          },
        },
      },
    });

    if (!shop) {
      throw new Error(`Shop not found for domain: ${input.shopDomain}`);
    }

    const delayMinutes =
      shop.settings?.recoveryDelayMinutes ?? DEFAULT_RECOVERY_DELAY_MINUTES;

    const candidate: PendingRecoveryCandidate = {
      shopId: shop.id,
      checkoutToken: input.checkoutToken,
      cartToken: input.cartToken,
      abandonedCheckoutUrl: input.abandonedCheckoutUrl,
      checkoutCreatedAt: input.checkoutCreatedAt,
    };

    const queue = getPendingCandidateQueue();
    const jobId = createPendingRecoveryCandidateJobId(
      candidate.shopId,
      candidate.checkoutToken,
    );

    const existingJob = await queue.getJob(jobId);
    if (existingJob) {
      await existingJob.updateData(candidate);
      const state = await existingJob.getState();
      if (state === "delayed") {
        await existingJob.changeDelay(delayMinutes * 60_000);
      }

      await this.upsertIndexes(candidate, jobId, delayMinutes);

      return {
        outcome: "refreshed",
        jobId,
        delayMinutes,
        candidate,
      };
    }

    await queue.add(EVALUATE_PENDING_RECOVERY_JOB, candidate, {
      jobId,
      delay: delayMinutes * 60_000,
    });

    await this.upsertIndexes(candidate, jobId, delayMinutes);

    return {
      outcome: "enqueued",
      jobId,
      delayMinutes,
      candidate,
    };
  }

  async findCandidateJobIdByCheckout(input: {
    shopId: string;
    checkoutToken: string;
  }) {
    return connectionRedis.get(
      pendingCandidateCheckoutIndexKey({
        shopId: input.shopId,
        checkoutToken: input.checkoutToken,
      }),
    );
  }

  async findCandidateJobIdByCart(input: { shopId: string; cartToken: string }) {
    return connectionRedis.get(
      pendingCandidateCartIndexKey({
        shopId: input.shopId,
        cartToken: input.cartToken,
      }),
    );
  }

  async cancelCandidateByCheckout(input: {
    shopId: string;
    checkoutToken: string;
  }) {
    const queue = getPendingCandidateQueue();
    const jobId = await this.findCandidateJobIdByCheckout(input);

    if (!jobId) {
      return { removed: false } as const;
    }

    const job = await queue.getJob(jobId);
    if (job) {
      await job.remove();
    }

    await this.removeIndexes({
      shopId: input.shopId,
      checkoutToken: input.checkoutToken,
      cartToken: null,
      abandonedCheckoutUrl: null,
      checkoutCreatedAt: null,
    });

    return { removed: true } as const;
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
    const queue = getPendingCandidateQueue();

    let jobId: string | null = null;

    if (input.checkoutToken) {
      jobId = await this.findCandidateJobIdByCheckout({
        shopId: input.shopId,
        checkoutToken: input.checkoutToken,
      });
    }

    if (!jobId && input.cartToken) {
      jobId = await this.findCandidateJobIdByCart({
        shopId: input.shopId,
        cartToken: input.cartToken,
      });
    }

    if (!jobId) {
      return null;
    }

    const job = await queue.getJob(jobId);
    if (!job) {
      return null;
    }

    return { jobId, candidate: job.data };
  }

  /**
   * Cancel a resolved pending candidate: remove the delayed BullMQ job and all
   * of its transient correlation aliases (checkout and cart indexes).
   */
  async cancelCandidate(input: {
    jobId: string;
    candidate: PendingRecoveryCandidate;
  }): Promise<{ removed: true }> {
    const queue = getPendingCandidateQueue();

    const job = await queue.getJob(input.jobId);
    if (job) {
      await job.remove();
    }

    await this.removeIndexes(input.candidate);

    return { removed: true } as const;
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
    const lockKey = checkoutOrderLockKey({ shopId, checkoutToken });
    const owner = `${Date.now()}-${Math.random()}`;

    for (let attempt = 0; attempt < CHECKOUT_LOCK_RETRIES; attempt += 1) {
      const acquired = await connectionRedis.set(
        lockKey,
        owner,
        "PX",
        CHECKOUT_LOCK_TTL_MS,
        "NX",
      );

      if (acquired === "OK") {
        try {
          return await fn();
        } finally {
          // Release only if we still own the lock (do not delete a later owner's
          // lock if our TTL expired mid-operation).
          const value = await connectionRedis.get(lockKey);
          if (value === owner) {
            await connectionRedis.del(lockKey);
          }
        }
      }

      await sleep(CHECKOUT_LOCK_RETRY_DELAY_MS);
    }

    throw new Error(
      `Timed out acquiring checkout lock for ${shopId}:${checkoutToken}`,
    );
  }

  /**
   * Record that an order for a checkout has been processed. The candidate
   * materialization path reads this to suppress an inappropriate recovery
   * message when the order completed the checkout first.
   */
  async markOrderProcessed(shopId: string, checkoutToken: string) {
    await connectionRedis.set(
      checkoutOrderCompletedKey({ shopId, checkoutToken }),
      "1",
      "PX",
      ORDER_COMPLETED_TOMBSTONE_TTL_MS,
    );
  }

  /**
   * True when an order for the checkout has already been processed. Used by the
   * materialization path as a checkout-scoped guard before creating a recovery.
   */
  async hasOrderProcessed(shopId: string, checkoutToken: string) {
    const value = await connectionRedis.get(
      checkoutOrderCompletedKey({ shopId, checkoutToken }),
    );
    return value != null;
  }

  async handleCandidateMatured(candidate: PendingRecoveryCandidate) {
    await this.removeIndexes(candidate);
    return candidate;
  }

  private async upsertIndexes(
    candidate: PendingRecoveryCandidate,
    jobId: string,
    delayMinutes: number,
  ) {
    const ttlMs = pendingCandidateIndexTtlMs(delayMinutes);

    await connectionRedis.set(
      pendingCandidateCheckoutIndexKey({
        shopId: candidate.shopId,
        checkoutToken: candidate.checkoutToken,
      }),
      jobId,
      "PX",
      ttlMs,
    );

    if (candidate.cartToken) {
      await connectionRedis.set(
        pendingCandidateCartIndexKey({
          shopId: candidate.shopId,
          cartToken: candidate.cartToken,
        }),
        jobId,
        "PX",
        ttlMs,
      );
    }
  }

  private async removeIndexes(candidate: PendingRecoveryCandidate) {
    const keys = [
      pendingCandidateCheckoutIndexKey({
        shopId: candidate.shopId,
        checkoutToken: candidate.checkoutToken,
      }),
    ];

    if (candidate.cartToken) {
      keys.push(
        pendingCandidateCartIndexKey({
          shopId: candidate.shopId,
          cartToken: candidate.cartToken,
        }),
      );
    }

    await connectionRedis.del(...keys);
  }
}

export const pendingRecoveryCandidateService =
  new PendingRecoveryCandidateService();

