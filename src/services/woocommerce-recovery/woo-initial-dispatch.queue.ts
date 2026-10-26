import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";

import { PENDING_RECOVERY_CANDIDATE_QUEUE } from "../../domain/pending-recovery-candidate.js";
import { connectionRedis } from "../../lib/redis.js";

/** Internal Background job, never emitted by Woo/API/Shopify. No follow-up job exists. */
export const WOO_INITIAL_DISPATCH_JOB = "woo-recovery-initial-v1";
export type WooInitialDispatchJob = Readonly<{
  source: "woocommerce";
  recoveryId: string;
  attemptId: string;
}>;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
export class InvalidWooInitialDispatchJob extends Error {
  constructor() { super("Invalid Woo initial dispatch job"); }
}

export function wooInitialDispatchJobId(data: WooInitialDispatchJob): string {
  return `woo-initial-${createHash("sha256")
    .update(data.recoveryId).update("\0").update(data.attemptId).digest("hex")}`;
}

export function parseWooInitialDispatchJob(job: {
  name: string; id?: string; data: unknown;
}): WooInitialDispatchJob {
  const data = job.data;
  if (job.name !== WOO_INITIAL_DISPATCH_JOB || !data || typeof data !== "object" || Array.isArray(data)) {
    throw new InvalidWooInitialDispatchJob();
  }
  const fields = data as Record<string, unknown>;
  if (Object.keys(fields).sort().join(",") !== "attemptId,recoveryId,source" ||
    fields.source !== "woocommerce" || typeof fields.recoveryId !== "string" ||
    typeof fields.attemptId !== "string" || !ID.test(fields.recoveryId) ||
    !ID.test(fields.attemptId)) throw new InvalidWooInitialDispatchJob();
  const verified: WooInitialDispatchJob = {
    source: "woocommerce", recoveryId: fields.recoveryId, attemptId: fields.attemptId,
  };
  if (job.id !== wooInitialDispatchJobId(verified)) throw new InvalidWooInitialDispatchJob();
  return verified;
}

export type WooInitialQueuePort = Pick<Queue<WooInitialDispatchJob>, "add" | "getJob" | "close">;

/** Reuse the existing recovery worker queue and its bounded retry policy. */
export class WooInitialDispatchQueue {
  constructor(private readonly queue: WooInitialQueuePort = new Queue<WooInitialDispatchJob>(
    PENDING_RECOVERY_CANDIDATE_QUEUE, {
      connection: connectionRedis,
      telemetry: createBullMQTelemetry({ serviceName: "moda-recovery-worker", enableMetrics: false }),
      defaultJobOptions: {
        attempts: 3, backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: true, removeOnFail: false,
      },
    },
  )) {}

  async initial(recoveryId: string, attemptId: string): Promise<void> {
    const data: WooInitialDispatchJob = { source: "woocommerce", recoveryId, attemptId };
    if (!ID.test(recoveryId) || !ID.test(attemptId)) throw new InvalidWooInitialDispatchJob();
    const jobId = wooInitialDispatchJobId(data);
    const previous = await this.queue.getJob(jobId);
    if (previous) {
      parseWooInitialDispatchJob(previous);
      if (await previous.getState() === "failed") await previous.retry("failed");
      return;
    }
    // Acknowledged Queue.add is the durable acceptance point. The recovery
    // worker may finish/remove the job before any subsequent getJob; absence
    // at that point is not a failed enqueue.
    const committed = await this.queue.add(WOO_INITIAL_DISPATCH_JOB, data, { jobId });
    if (!committed || committed.id !== jobId) throw new Error("WOO_INITIAL_ENQUEUE_UNCONFIRMED");
    const stillQueued = await this.queue.getJob(jobId);
    if (stillQueued) parseWooInitialDispatchJob(stillQueued);
  }

  close(): Promise<void> {
    return this.queue.close();
  }
}
