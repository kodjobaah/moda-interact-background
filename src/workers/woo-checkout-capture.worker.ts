import { Worker } from "bullmq";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";
import { createLogger } from "@modainteract/moda-interact-shared/logging";

import { connectionRedis } from "../lib/redis.js";
import { observeWorkerJob } from "../observability/worker-metrics.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import {
  InvalidWooCheckoutCaptureJob,
  parseWooCheckoutCaptureJob,
  WOO_CHECKOUT_CAPTURE_JOB,
  WOO_CHECKOUT_CAPTURE_QUEUE,
} from "../events/woo-checkout-capture.js";

const logger = createLogger({
  serviceName: "moda-shopify-event-worker",
  environment: resolveDeploymentEnvironmentName(),
});
const telemetry = createBullMQTelemetry({ serviceName: "moda-shopify-event-worker", enableMetrics: false });
const metric = {
  workerName: "woo-checkout-capture",
  queueName: WOO_CHECKOUT_CAPTURE_QUEUE,
  jobNames: [WOO_CHECKOUT_CAPTURE_JOB],
} as const;

/** Deliberately no recovery service, database or messaging dependency. A valid
 * event is observed once per successful BullMQ processing attempt and discarded. */
export function createWooCheckoutCaptureWorker() {
  const worker = new Worker<unknown>(
    WOO_CHECKOUT_CAPTURE_QUEUE,
    async (job) => observeWorkerJob(metric, job, async () => {
      const fields = {
        jobId: typeof job.id === "string" && /^woo-checkout-[0-9a-f]{64}$/.test(job.id) ? job.id : null,
        attempt: job.attemptsMade + 1,
      };
      let accepted;
      try {
        accepted = parseWooCheckoutCaptureJob(job);
      } catch (error) {
        logger.error("woocommerce.checkout_capture.failed", {
          ...fields,
          reason: error instanceof InvalidWooCheckoutCaptureJob ? error.reason : "processing_failure",
        });
        throw error; // BullMQ retains failed jobs and owns any configured retry.
      }
      // Shared logging isolates sink failures from business processing. No
      // CheckoutRecovery, candidate, billing, or WhatsApp operation follows.
      logger.info("woocommerce.checkout_capture.accepted", {
        ...fields,
        shopId: accepted.shopId,
        eventId: accepted.eventId,
        checkoutKey: accepted.checkoutKey,
        eventType: accepted.eventType,
      });
    }),
    { connection: connectionRedis, telemetry, concurrency: 4 },
  );
  worker.on("ready", () => logger.info("woocommerce.checkout_capture.worker_ready", {
    queueName: WOO_CHECKOUT_CAPTURE_QUEUE,
  }));
  worker.on("error", (error) => logger.error("woocommerce.checkout_capture.worker_error", {
    queueName: WOO_CHECKOUT_CAPTURE_QUEUE,
    errorName: error.name.slice(0, 64), // Never log Redis messages or payloads.
  }));
  return worker;
}
