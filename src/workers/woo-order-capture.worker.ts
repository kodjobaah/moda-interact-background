import { createHash } from "node:crypto";
import { Worker } from "bullmq";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";
import { createLogger } from "@modainteract/moda-interact-shared/logging";

import { connectionRedis } from "../lib/redis.js";
import { observeWorkerJob } from "../observability/worker-metrics.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import {
  InvalidWooOrderCaptureJob, parseWooOrderCaptureJob,
  WOO_ORDER_CAPTURE_JOB, WOO_ORDER_CAPTURE_QUEUE,
} from "../events/woo-order-capture.js";
import type { WooRecoveryOrchestratorService } from "../services/woocommerce-recovery/woo-recovery-orchestrator.service.js";

const logger = createLogger({
  serviceName: "moda-shopify-event-worker", environment: resolveDeploymentEnvironmentName(),
});
const telemetry = createBullMQTelemetry({ serviceName: "moda-shopify-event-worker", enableMetrics: false });
const metric = { workerName: "woo-order-capture", queueName: WOO_ORDER_CAPTURE_QUEUE,
  jobNames: [WOO_ORDER_CAPTURE_JOB] } as const;

export function createWooOrderCaptureWorker(
  orchestrator?: Pick<WooRecoveryOrchestratorService, "onOrder">,
) {
  const worker = new Worker<unknown>(WOO_ORDER_CAPTURE_QUEUE,
    async (job) => observeWorkerJob(metric, job, async () => {
      const fields = {
        jobId: typeof job.id === "string" && /^woo-order-[0-9a-f]{64}$/.test(job.id) ? job.id : null,
        attempt: job.attemptsMade + 1, queue: WOO_ORDER_CAPTURE_QUEUE,
        source: "woocommerce", stage: "order-capture",
      };
      let stage = "validate";
      let shopId: string | undefined;
      let eventId: string | undefined;
      try {
        const accepted = parseWooOrderCaptureJob(job);
        shopId = accepted.shopId;
        eventId = createHash("sha256").update(accepted.eventId).digest("hex");
        logger.info("woocommerce.recovery.job.started", { ...fields, shopId, eventId });
        stage = "orchestrate";
        if (!orchestrator) throw new Error("WOO_RECOVERY_ORCHESTRATOR_UNAVAILABLE");
        const outcome = await orchestrator.onOrder(accepted);
        const context = { ...fields, shopId, eventId, outcome: outcome.kind,
          ...( "reason" in outcome ? { reason: outcome.reason.slice(0, 64) } : {}),
        };
        if (outcome.kind === "deferred-conflict") {
          logger.warn("woocommerce.recovery.job.deferred", context);
        } else {
          logger.info("woocommerce.recovery.job.completed", context);
        }
      } catch (error) {
        logger.error("woocommerce.recovery.job.failed", {
          ...fields, ...(shopId ? { shopId } : {}), ...(eventId ? { eventId } : {}), stage,
          reason: error instanceof InvalidWooOrderCaptureJob ? error.reason : "processing_failure",
          errorName: error instanceof Error ? error.name.slice(0, 64) : "UnknownError",
        });
        throw error;
      }
    }), { connection: connectionRedis, telemetry, concurrency: 4 });
  worker.on("ready", () => logger.info("woocommerce.order_capture.worker_ready", {
    queueName: WOO_ORDER_CAPTURE_QUEUE,
  }));
  worker.on("error", (error) => logger.error("woocommerce.order_capture.worker_error", {
    queueName: WOO_ORDER_CAPTURE_QUEUE, errorName: error.name.slice(0, 64),
  }));
  return worker;
}
