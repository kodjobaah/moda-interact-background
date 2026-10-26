import { createHash } from "node:crypto";
import { Worker } from "bullmq";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";
import { createLogger } from "@modainteract/moda-interact-shared/logging";

import { connectionRedis } from "../lib/redis.js";
import { observeWorkerJob } from "../observability/worker-metrics.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import {
  InvalidWooCheckoutCaptureJob, parseWooCheckoutCaptureJob,
  WOO_CHECKOUT_CAPTURE_JOB, WOO_CHECKOUT_CAPTURE_QUEUE,
} from "../events/woo-checkout-capture.js";
import type { WooRecoveryOrchestratorService } from "../services/woocommerce-recovery/woo-recovery-orchestrator.service.js";

const logger = createLogger({
  serviceName: "moda-shopify-event-worker", environment: resolveDeploymentEnvironmentName(),
});
const telemetry = createBullMQTelemetry({ serviceName: "moda-shopify-event-worker", enableMetrics: false });
const metric = { workerName: "woo-checkout-capture", queueName: WOO_CHECKOUT_CAPTURE_QUEUE,
  jobNames: [WOO_CHECKOUT_CAPTURE_JOB] } as const;

/** Must be composed at the production entrypoint; missing wiring fails closed. */
export function createWooCheckoutCaptureWorker(
  orchestrator?: Pick<WooRecoveryOrchestratorService, "onCheckout">,
) {
  const worker = new Worker<unknown>(WOO_CHECKOUT_CAPTURE_QUEUE,
    async (job) => observeWorkerJob(metric, job, async () => {
      const fields = {
        jobId: typeof job.id === "string" && /^woo-checkout-[0-9a-f]{64}$/.test(job.id) ? job.id : null,
        attempt: job.attemptsMade + 1, queue: WOO_CHECKOUT_CAPTURE_QUEUE,
        source: "woocommerce", stage: "checkout-capture",
      };
      let stage = "validate";
      let shopId: string | undefined;
      let eventId: string | undefined;
      try {
        const accepted = parseWooCheckoutCaptureJob(job);
        shopId = accepted.shopId;
        eventId = createHash("sha256").update(accepted.eventId).digest("hex");
        logger.info("woocommerce.recovery.job.started", { ...fields, shopId, eventId });
        stage = "orchestrate";
        if (!orchestrator) throw new Error("WOO_RECOVERY_ORCHESTRATOR_UNAVAILABLE");
        const outcome = await orchestrator.onCheckout(accepted);
        const context = { ...fields, shopId, eventId, outcome: outcome.kind,
          ...( "reason" in outcome ? { reason: outcome.reason.slice(0, 64) } : {}),
        };
        if (outcome.kind === "deferred-ambiguous") {
          logger.warn("woocommerce.recovery.job.deferred", context);
        } else {
          logger.info("woocommerce.recovery.job.completed", context);
        }
      } catch (error) {
        logger.error("woocommerce.recovery.job.failed", {
          ...fields, ...(shopId ? { shopId } : {}), ...(eventId ? { eventId } : {}), stage,
          reason: error instanceof InvalidWooCheckoutCaptureJob ? error.reason : "processing_failure",
          errorName: error instanceof Error ? error.name.slice(0, 64) : "UnknownError",
        });
        throw error;
      }
    }), { connection: connectionRedis, telemetry, concurrency: 4 });
  worker.on("ready", () => logger.info("woocommerce.checkout_capture.worker_ready", {
    queueName: WOO_CHECKOUT_CAPTURE_QUEUE,
  }));
  worker.on("error", (error) => logger.error("woocommerce.checkout_capture.worker_error", {
    queueName: WOO_CHECKOUT_CAPTURE_QUEUE, errorName: error.name.slice(0, 64),
  }));
  return worker;
}
