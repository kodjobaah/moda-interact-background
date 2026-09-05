import {
  metrics,
  type Attributes,
  type Counter,
  type Histogram,
  type ObservableGauge,
} from "@opentelemetry/api";
import { Queue, QueueEvents, type Job } from "bullmq";
import type { Redis } from "ioredis";

export type QueueName =
  | "checkout-events"
  | "order-events"
  | "pending-recovery-candidates"
  | "whatsapp-events";

type QueueSnapshot = {
  active: number;
  delayed: number;
  failed: number;
  oldestWaitingAgeMs: number | null;
  waiting: number;
};

type QueuePerformanceInstruments = {
  jobs: ObservableGauge;
  oldestWaitingAge: ObservableGauge;
  transitions: Counter;
  queueWait: Histogram;
};

type QueueJobMetadata = Pick<Job, "id" | "processedOn">;

const MAX_TRACKED_ELIGIBILITY_ENTRIES = 10_000;
const ELIGIBILITY_RETENTION_MS = 2 * 60 * 60 * 1_000;

const EMPTY_SNAPSHOT: QueueSnapshot = {
  active: 0,
  delayed: 0,
  failed: 0,
  oldestWaitingAgeMs: null,
  waiting: 0,
};
const snapshots = new Map<QueueName, QueueSnapshot>();
const eligibleAtByQueue = new Map<QueueName, Map<string, number>>();
const instruments = createInstruments();

export function recordQueueWait(
  queueName: QueueName,
  job: QueueJobMetadata,
): void {
  if (!job.id) return;
  const eligibleAt = eligibleAtByQueue.get(queueName)?.get(job.id);
  if (eligibleAt === undefined) return;
  const processingStartedAt = job.processedOn ?? Date.now();
  const attributes: Attributes = { "bullmq.queue.name": queueName };

  safelyRecord(() =>
    instruments.queueWait.record(
      Math.max(0, processingStartedAt - eligibleAt),
      attributes,
    ),
  );
}

export function recordQueueEligibility(
  queueName: QueueName,
  jobId: string,
  eligibleAt = Date.now(),
): void {
  let queueEligibility = eligibleAtByQueue.get(queueName);
  if (!queueEligibility) {
    queueEligibility = new Map();
    eligibleAtByQueue.set(queueName, queueEligibility);
  }

  pruneEligibility(queueEligibility, eligibleAt);
  queueEligibility.set(jobId, eligibleAt);
  while (queueEligibility.size > MAX_TRACKED_ELIGIBILITY_ENTRIES) {
    const oldestJobId = queueEligibility.keys().next().value;
    if (oldestJobId === undefined) break;
    queueEligibility.delete(oldestJobId);
  }
}

export function startQueuePerformanceTelemetry({
  connection,
  queueNames,
  sampleIntervalMs = 30_000,
}: {
  connection: Redis;
  queueNames: readonly QueueName[];
  sampleIntervalMs?: number;
}): () => Promise<void> {
  const resources: Array<{
    events: QueueEvents;
    queue: Queue;
    queueName: QueueName;
  }> = [];

  for (const queueName of [...new Set(queueNames)]) {
    let queue: Queue | undefined;
    let events: QueueEvents | undefined;
    try {
      queue = new Queue(queueName, { connection });
      events = new QueueEvents(queueName, { connection });
      snapshots.delete(queueName);
      eligibleAtByQueue.set(queueName, new Map());
      queue.on("error", () => undefined);
      events.on("error", () => undefined);

      events.on("waiting", ({ jobId }) => {
        recordQueueEligibility(queueName, jobId);
        recordTransition(queueName, "waiting");
      });
      for (const transition of ["completed", "failed"] as const) {
        events.on(transition, (args: unknown) => {
          const { jobId } = args as { jobId: string };
          eligibleAtByQueue.get(queueName)?.delete(jobId);
          recordTransition(queueName, transition);
        });
      }

      for (const transition of [
        "added",
        "active",
        "delayed",
        "stalled",
      ] as const) {
        events.on(transition, () => recordTransition(queueName, transition));
      }

      void sampleQueue(queueName, queue);
      resources.push({ events, queue, queueName });
    } catch {
      snapshots.delete(queueName);
      eligibleAtByQueue.delete(queueName);
      void events?.close().catch(() => undefined);
      void queue?.close().catch(() => undefined);
    }
  }
  const interval = setInterval(() => {
    for (const { queue, queueName } of resources) void sampleQueue(queueName, queue);
  }, sampleIntervalMs);
  interval.unref();

  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    await Promise.all(resources.map(async ({ events, queue, queueName }) => {
      await Promise.allSettled([events.close(), queue.close()]);
      snapshots.delete(queueName);
      eligibleAtByQueue.delete(queueName);
    }));
  };
}

function createInstruments(): QueuePerformanceInstruments {
  try {
    const meter = metrics.getMeter("moda-interact-background.queue-performance");
    const jobs = meter.createObservableGauge("moda.background.queue.jobs", {
      description: "Current BullMQ jobs by operational state",
      unit: "1",
    });
    const oldestWaitingAge = meter.createObservableGauge(
      "moda.background.queue.oldest_waiting_age_ms",
      {
        description: "Age of the oldest eligible waiting BullMQ job",
        unit: "ms",
      },
    );
    jobs.addCallback((result) => {
      for (const [queueName, snapshot] of snapshots) {
        for (const state of ["waiting", "active", "delayed", "failed"] as const) {
          result.observe(snapshot[state], {
            "bullmq.queue.name": queueName,
            "bullmq.job.state": state,
          });
        }
      }
    });
    oldestWaitingAge.addCallback((result) => {
      for (const [queueName, snapshot] of snapshots) {
        if (snapshot.oldestWaitingAgeMs === null) continue;
        result.observe(snapshot.oldestWaitingAgeMs, {
          "bullmq.queue.name": queueName,
        });
      }
    });
    return {
      jobs,
      oldestWaitingAge,
      transitions: meter.createCounter(
        "moda.background.queue.transition.operations",
        {
          description: "BullMQ queue state transitions",
          unit: "1",
        },
      ),
      queueWait: meter.createHistogram(
        "moda.background.worker.job.queue_wait_ms",
        {
          description: "Time from BullMQ eligibility to processor start",
          unit: "ms",
        },
      ),
    };
  } catch {
    return {
      jobs: { addCallback() {}, removeCallback() {} },
      oldestWaitingAge: { addCallback() {}, removeCallback() {} },
      transitions: { add() {} },
      queueWait: { record() {} },
    };
  }
}

async function sampleQueue(queueName: QueueName, queue: Queue): Promise<void> {
  try {
    const counts = await queue.getJobCounts(
      "waiting",
      "active",
      "delayed",
      "failed",
    );
    const oldestWaiting = await queue.getJobs("waiting", 0, 0, true);
    const oldest = oldestWaiting[0];
    const eligibleAt = oldest
      ? eligibleAtByQueue.get(queueName)?.get(oldest.id ?? "")
      : undefined;
    snapshots.set(queueName, {
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      oldestWaitingAgeMs:
        eligibleAt === undefined ? null : Math.max(0, Date.now() - eligibleAt),
      waiting: counts.waiting ?? 0,
    });
  } catch {
    snapshots.delete(queueName);
  }
}

function pruneEligibility(
  queueEligibility: Map<string, number>,
  now: number,
): void {
  for (const [jobId, eligibleAt] of queueEligibility) {
    if (now - eligibleAt > ELIGIBILITY_RETENTION_MS) {
      queueEligibility.delete(jobId);
    }
  }
}

function recordTransition(queueName: QueueName, transition: string): void {
  safelyRecord(() =>
    instruments.transitions.add(1, {
      "bullmq.queue.name": queueName,
      "bullmq.job.transition": transition,
    }),
  );
}

function safelyRecord(record: () => void): void {
  try {
    record();
  } catch {
    // Keep telemetry failures isolated from business processing.
  }
}