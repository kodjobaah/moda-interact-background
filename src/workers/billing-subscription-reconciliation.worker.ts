import { Worker, type Job } from "bullmq";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";
import {
  BILLING_SUBSCRIPTION_RECONCILE_JOB_NAME,
  BILLING_SUBSCRIPTION_RECONCILE_QUEUE_NAME,
} from "@modainteract/moda-interact-shared/billing";

import { connectionRedis } from "../lib/redis.js";
import { observeWorkerJob } from "../observability/worker-metrics.js";
import { billingSubscriptionReconciliationService } from "../services/billing-subscription-reconciliation.service.js";

const bullMQTelemetry = createBullMQTelemetry({ serviceName: "moda-billing-worker", enableMetrics: false });

export const billingSubscriptionReconciliationWorker = new Worker(
  BILLING_SUBSCRIPTION_RECONCILE_QUEUE_NAME,
  async (job: Job) => observeWorkerJob(
    { workerName: "billing-subscription-reconciliation", queueName: BILLING_SUBSCRIPTION_RECONCILE_QUEUE_NAME, jobNames: [BILLING_SUBSCRIPTION_RECONCILE_JOB_NAME] },
    job,
    () => billingSubscriptionReconciliationService.reconcileJob(job.data),
  ),
  { connection: connectionRedis, concurrency: 10, telemetry: bullMQTelemetry },
);
