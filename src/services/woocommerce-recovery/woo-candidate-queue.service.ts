import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";

import {
  EVALUATE_PENDING_RECOVERY_JOB,
  PENDING_RECOVERY_CANDIDATE_QUEUE,
} from "../../domain/pending-recovery-candidate.js";
import { connectionRedis } from "../../lib/redis.js";
import { PendingRecoveryCandidateIndexStore } from "../pending-recovery-candidate/candidate-index.store.js";
import type { WooCandidateManager, WooCheckoutRef, WooPendingCandidate } from "./contracts.js";

export type WooCandidateJobPort = {
  data: WooPendingCandidate;
  getState(): Promise<string>;
  updateData(candidate: WooPendingCandidate): Promise<unknown>;
  changeDelay(delayMs: number): Promise<unknown>;
  remove(): Promise<unknown>;
};

export type WooCandidateQueuePort = {
  getJob(jobId: string): Promise<WooCandidateJobPort | null | undefined>;
  add(
    jobName: string,
    candidate: WooPendingCandidate,
    opts: { jobId: string; delay: number },
  ): Promise<unknown>;
};

export type WooCandidateIndexPort = Pick<
  PendingRecoveryCandidateIndexStore,
  "findByCheckout" | "upsert" | "remove"
>;

export interface WooCandidateScheduler extends WooCandidateManager {
  schedulePending(input: {
    candidate: WooPendingCandidate;
    delayMinutes: number;
    dueAtMs: number;
    retentionMs: number;
  }): Promise<"scheduled" | "rescheduled">;
}

export class WooCandidateMutationBlocked extends Error {
  constructor(readonly reason: "job_not_mutable" | "unexpected_source" | "job_identity_conflict") {
    super(`Woo candidate mutation refused: ${reason}`);
  }
}

/** A separate deterministic namespace keeps Woo candidate jobs away from the
 * existing Shopify job IDs, while sharing the approved candidate queue/index. */
export function wooCandidateJobId(ref: WooCheckoutRef): string {
  const digest = createHash("sha256")
    .update(ref.shopId).update("\0").update(ref.checkoutToken).digest("hex");
  return `woo-candidate-${digest}`;
}

let wooCandidateQueue: Queue<WooPendingCandidate, void, string> | null = null;

export function getWooCandidateQueue(): Queue<WooPendingCandidate, void, string> {
  if (!wooCandidateQueue) {
    wooCandidateQueue = new Queue(PENDING_RECOVERY_CANDIDATE_QUEUE, {
      connection: connectionRedis,
      telemetry: createBullMQTelemetry({ serviceName: "moda-recovery-worker", enableMetrics: false }),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });
  }
  return wooCandidateQueue;
}

/** BG001 owns the queue/index adapter, BG002 supplies the same scoped guard.
 * The caller MUST hold WooCheckoutCoordinator.withCheckoutLock while mutating. */
export class WooPendingCandidateQueueService implements WooCandidateScheduler {
  constructor(
    private readonly queue: WooCandidateQueuePort = getWooCandidateQueue(),
    private readonly index: WooCandidateIndexPort = new PendingRecoveryCandidateIndexStore(),
    private readonly now: () => number = Date.now,
  ) {}

  private verify(ref: WooCheckoutRef, candidate: WooPendingCandidate): void {
    if (candidate?.source !== "woocommerce") {
      throw new WooCandidateMutationBlocked("unexpected_source");
    }
    if (candidate.shopId !== ref.shopId || candidate.checkoutToken !== ref.checkoutToken) {
      throw new WooCandidateMutationBlocked("job_identity_conflict");
    }
  }

  private async resolve(ref: WooCheckoutRef): Promise<{
    jobId: string;
    job: WooCandidateJobPort;
  } | null> {
    const indexedId = await this.index.findByCheckout(ref);
    const baseId = wooCandidateJobId(ref);
    const jobId = indexedId ?? baseId;
    const job = await this.queue.getJob(jobId);
    if (job) {
      this.verify(ref, job.data);
      return { jobId, job };
    }
    if (indexedId && indexedId !== baseId) {
      // A dangling index is not evidence of a Woo job. Do not overwrite a
      // foreign namespace or silently discard its correlation key.
      throw new WooCandidateMutationBlocked("job_identity_conflict");
    }
    return null;
  }

  async getPending(ref: WooCheckoutRef): Promise<WooPendingCandidate | null> {
    const found = await this.resolve(ref);
    if (!found) return null;
    const state = await found.job.getState();
    if (["delayed", "waiting", "active"].includes(state)) return found.job.data;
    if (state === "completed") return null;
    throw new WooCandidateMutationBlocked("job_not_mutable");
  }

  async cancelPending(ref: WooCheckoutRef): Promise<"cancelled" | "absent"> {
    const found = await this.resolve(ref);
    if (!found) {
      // Remove a stale Woo index (e.g. removeOnComplete) without touching jobs.
      const indexed = await this.index.findByCheckout(ref);
      if (indexed === wooCandidateJobId(ref)) {
        await this.index.remove(ref, indexed);
      }
      return "absent";
    }
    const state = await found.job.getState();
    if (!["delayed", "waiting", "completed", "failed"].includes(state)) {
      throw new WooCandidateMutationBlocked("job_not_mutable");
    }
    await found.job.remove();
    await this.index.remove(ref, found.jobId);
    return "cancelled";
  }

  async schedulePending(input: {
    candidate: WooPendingCandidate;
    delayMinutes: number;
    dueAtMs: number;
    retentionMs: number;
  }): Promise<"scheduled" | "rescheduled"> {
    const { candidate, delayMinutes, dueAtMs, retentionMs } = input;
    const ref = { shopId: candidate.shopId, checkoutToken: candidate.checkoutToken };
    this.verify(ref, candidate); // Reject malformed source before any queue mutation.
    const found = await this.resolve(ref);
    const delay = Math.max(0, dueAtMs - this.now());
    const jobId = found?.jobId ?? wooCandidateJobId(ref);

    if (found) {
      if (await found.job.getState() !== "delayed") {
        // Never rewrite an active/waiting/finished job: maturity may already
        // have been claimed. BullMQ retries the capture event on this error.
        throw new WooCandidateMutationBlocked("job_not_mutable");
      }
      await found.job.updateData(candidate);
      await found.job.changeDelay(delay);
    } else {
      await this.queue.add(EVALUATE_PENDING_RECOVERY_JOB, candidate, { jobId, delay });
      // A concurrent insertion or conflicting source is not success.
      const added = await this.queue.getJob(jobId);
      if (!added) throw new WooCandidateMutationBlocked("job_identity_conflict");
      this.verify(ref, added.data);
    }

    await this.index.upsert({
      candidate,
      jobId,
      delayMinutes,
      dueAtMs,
      shouldIndexShop: true,
      retentionMs,
    });
    return found ? "rescheduled" : "scheduled";
  }
}
