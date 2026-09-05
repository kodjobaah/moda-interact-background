import {
  metrics,
  type Attributes,
  type Counter,
  type Histogram,
} from "@opentelemetry/api";
import type { Job } from "bullmq";

import { recordQueueWait } from "./queue-performance.js";

type WorkerName =
  | "checkout"
  | "order"
  | "pending-recovery-candidate"
  | "whatsapp";

type QueueName =
  | "checkout-events"
  | "order-events"
  | "pending-recovery-candidates"
  | "whatsapp-events";

type WorkerMetricDefinition = {
  workerName: WorkerName;
  queueName: QueueName;
  jobNames: readonly string[];
};

type WorkerJobMetadata = Pick<
  Job,
  | "name"
  | "timestamp"
  | "id"
  | "processedOn"
  | "attemptsStarted"
  | "attemptsMade"
>;

type WorkerMetricInstruments = {
  operations: Counter;
  duration: Histogram;
  processingAge: Histogram;
};

type Outcome = "success" | "failure";

const instruments = createInstruments();

export async function observeWorkerJob<T>(
  definition: WorkerMetricDefinition,
  job: WorkerJobMetadata,
  work: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  let outcome: Outcome = "failure";

  try {
    const result = await work();
    outcome = "success";
    return result;
  } finally {
    recordWorkerMetrics(
      definition,
      job,
      outcome,
      performance.now() - startedAt,
    );
  }
}

function createInstruments(): WorkerMetricInstruments {
  try {
    const meter = metrics.getMeter("moda-interact-background.worker");

    return {
      operations: meter.createCounter("moda.background.worker.job.operations", {
        description: "Number of background job processing attempts",
        unit: "1",
      }),
      duration: meter.createHistogram("moda.background.worker.job.duration_ms", {
        description: "Background job processor execution duration",
        unit: "ms",
      }),
      processingAge: meter.createHistogram(
        "moda.background.worker.job.processing_age_ms",
        {
          description: "Elapsed time from job creation to processing attempt",
          unit: "ms",
        },
      ),
    };
  } catch {
    return {
      operations: { add() {} },
      duration: { record() {} },
      processingAge: { record() {} },
    };
  }
}

function recordWorkerMetrics(
  definition: WorkerMetricDefinition,
  job: WorkerJobMetadata,
  outcome: Outcome,
  durationMs: number,
): void {
  try {
    const attributes: Attributes = {
      "moda.worker.name": definition.workerName,
      "bullmq.queue.name": definition.queueName,
      "bullmq.job.name": definition.jobNames.includes(job.name)
        ? job.name
        : "unknown",
      "moda.worker.outcome": outcome,
      "moda.worker.attempt":
        job.attemptsStarted > 1 || job.attemptsMade > 0 ? "retry" : "initial",
    };
    const processingStartedAt = job.processedOn ?? Date.now();
    const processingAgeMs = Math.max(0, processingStartedAt - job.timestamp);

    safelyRecord(() => instruments.operations.add(1, attributes));
    safelyRecord(() => instruments.duration.record(durationMs, attributes));
    safelyRecord(() =>
      instruments.processingAge.record(processingAgeMs, attributes),
    );
    recordQueueWait(definition.queueName, job);
  } catch {
    // Telemetry must not replace a job result or business error.
  }
}

function safelyRecord(record: () => void): void {
  try {
    record();
  } catch {
    // Keep independent metric failures isolated from job processing.
  }
}