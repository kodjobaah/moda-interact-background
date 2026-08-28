import { Queue } from "bullmq";

import prisma from "../lib/db.js";
import { connectionRedis } from "../lib/redis.js";
import {
  DEFAULT_RECOVERY_DELAY_MINUTES,
  EVALUATE_PENDING_RECOVERY_JOB,
  PENDING_RECOVERY_CANDIDATE_QUEUE,
  pendingCandidateCartIndexKey,
  pendingCandidateCheckoutIndexKey,
  pendingCandidateIndexTtlMs,
  type PendingRecoveryCandidate,
} from "../domain/pending-recovery-candidate.js";
import type { CheckoutCreatedContractInput } from "../events/shopify-contract-adapter.js";
import { createPendingRecoveryCandidateJobId } from "@modainteract/moda-interact-shared/shopify/node";

type CandidateEnqueueOutcome = "enqueued" | "refreshed";

let pendingCandidateQueue: Queue<PendingRecoveryCandidate, void, string> | null =
  null;

function getPendingCandidateQueue() {
  if (!pendingCandidateQueue) {
    pendingCandidateQueue = new Queue(PENDING_RECOVERY_CANDIDATE_QUEUE, {
      connection: connectionRedis,
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
