import type { Queue } from "bullmq";

const HEALTHY_JOB_STATES = new Set(["waiting", "delayed", "active"]);

type RepairQueue = Pick<Queue, "add" | "getJob">;

export type ExpectedTranslationQueueJob = {
  id: string;
  name: string;
  data: unknown;
};

export async function ensureDeterministicTranslationQueueJob(
  queue: RepairQueue,
  expected: ExpectedTranslationQueueJob,
): Promise<number> {
  const existing = await queue.getJob(expected.id);
  if (existing) {
    const state = await existing.getState();
    if (HEALTHY_JOB_STATES.has(state)) return 0;
    await existing.remove();
  }

  await queue.add(expected.name, expected.data, { jobId: expected.id });
  return 1;
}
