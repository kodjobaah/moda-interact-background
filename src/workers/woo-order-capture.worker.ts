import { Worker } from "bullmq";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";
import { createLogger } from "@modainteract/moda-interact-shared/logging";

import { connectionRedis } from "../lib/redis.js";
import { observeWorkerJob } from "../observability/worker-metrics.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import {
  InvalidWooOrderCaptureJob,
  parseWooOrderCaptureJob,
  WOO_ORDER_CAPTURE_JOB,
  WOO_ORDER_CAPTURE_QUEUE,
} from "../events/woo-order-capture.js";

const logger = createLogger({
  serviceName: "moda-shopify-event-worker",
  environment: resolveDeploymentEnvironmentName(),
});
const telemetry = createBullMQTelemetry({ serviceName: "moda-shopify-event-worker", enableMetrics: false });
const metric = {
  workerName: "woo-order-capture",
  queueName: WOO_ORDER_CAPTURE_QUEUE,
  jobNames: [WOO_ORDER_CAPTURE_JOB],
} as const;

/** Capture-only: no database, recovery, billing, Shopify event parser or
 * WhatsApp dependency. BullMQ handles duplicates, retries and failed jobs. */
export function createWooOrderCaptureWorker() {
  const worker = new Worker<unknown>(
    WOO_ORDER_CAPTURE_QUEUE,
    async (job) => observeWorkerJob(metric, job, async () => {
      const fields = {
        jobId: typeof job.id === "string" && /^woo-order-[0-9a-f]{64}$/.test(job.id) ? job.id : null,
        attempt: job.attemptsMade + 1,
      };
      let accepted;
      try {
        accepted = parseWooOrderCaptureJob(job);
      } catch (error) {
        logger.error("woocommerce.order_capture.failed", {
          ...fields,
          reason: error instanceof InvalidWooOrderCaptureJob ? error.reason : "processing_failure",
        });
        throw error;
      }
      logger.info("woocommerce.order_capture.accepted", {
        ...fields,
        shopId: accepted.shopId,
        eventId: accepted.eventId,
        eventType: accepted.eventType,
        occurredAt: accepted.occurredAt,
        orderId: accepted.order.orderId,
        checkoutKey: accepted.checkoutKey,
        status: accepted.order.status,
      });
    }),
    { connection: connectionRedis, telemetry, concurrency: 4 },
  );
  worker.on("ready", () => logger.info("woocommerce.order_capture.worker_ready", {
    queueName: WOO_ORDER_CAPTURE_QUEUE,
  }));
  worker.on("error", (error) => logger.error("woocommerce.order_capture.worker_error", {
    queueName: WOO_ORDER_CAPTURE_QUEUE,
    errorName: error.name.slice(0, 64),
  }));
  return worker;
}
