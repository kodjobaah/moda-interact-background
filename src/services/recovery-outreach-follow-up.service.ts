import { Queue } from "bullmq";
import { RECOVERY_OUTREACH_FOLLOW_UP_JOB, RECOVERY_OUTREACH_FOLLOW_UP_QUEUE, createRecoveryOutreachFollowUpJobId, type RecoveryOutreachFollowUpJob } from "../domain/recovery-outreach-follow-up.js";
import { connectionRedis } from "../lib/redis.js";

let queue: Queue<RecoveryOutreachFollowUpJob> | null = null;

function getQueue() {
  queue ??= new Queue(RECOVERY_OUTREACH_FOLLOW_UP_QUEUE, { connection: connectionRedis });
  return queue;
}

export const recoveryOutreachFollowUpService = {
  async schedule(input: RecoveryOutreachFollowUpJob, dueAt: Date): Promise<string> {
    const jobId = createRecoveryOutreachFollowUpJobId(input);
    await getQueue().add(RECOVERY_OUTREACH_FOLLOW_UP_JOB, input, {
      jobId,
      delay: Math.max(0, dueAt.getTime() - Date.now()),
      removeOnComplete: 100,
      removeOnFail: 100,
    });
    return jobId;
  },
  async close(): Promise<void> {
    await queue?.close();
    queue = null;
  },
};