import { Worker } from "bullmq";

import {
  EVALUATE_PENDING_RECOVERY_JOB,
  PENDING_RECOVERY_CANDIDATE_QUEUE,
  type PendingRecoveryCandidate,
} from "../domain/pending-recovery-candidate.js";
import { connectionRedis } from "../lib/redis.js";
import { pendingRecoveryCandidateService } from "../services/pending-recovery-candidate.service.js";

const pendingRecoveryCandidateWorker = new Worker<PendingRecoveryCandidate>(
  PENDING_RECOVERY_CANDIDATE_QUEUE,
  async (job) => {
    switch (job.name) {
      case EVALUATE_PENDING_RECOVERY_JOB:
        await pendingRecoveryCandidateService.handleCandidateMatured(job.data);
        return;
      default:
        throw new Error(`Unknown pending candidate job: ${job.name}`);
    }
  },
  {
    connection: connectionRedis,
    concurrency: 10,
  },
);

pendingRecoveryCandidateWorker.on("completed", (job) => {
  console.log(`Pending recovery candidate job ${job.id} completed`);
});

pendingRecoveryCandidateWorker.on("failed", (job, error) => {
  console.error(`Pending recovery candidate job ${job?.id} failed`, error);
});

pendingRecoveryCandidateWorker.on("error", (error) => {
  console.error("Pending recovery candidate worker error", error);
});
