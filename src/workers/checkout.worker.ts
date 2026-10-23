import { Worker } from "bullmq";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { createBullMQTelemetry } from "@modainteract/moda-interact-shared/observability/bullmq";

import { connectionRedis } from "../lib/redis.js";
import { observeWorkerJob } from "../observability/worker-metrics.js";
import { dispatchCheckoutQueueJob } from "../events/checkout-worker-dispatch.js";
import { ShopifyWhatsAppConsentService } from "../services/shopify-whatsapp-consent.service.js";
import { processShopifyWhatsAppConsentSyncJob } from "../services/shopify-whatsapp-consent-sync-job.service.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { checkoutRecoveryService } from "../services/checkout-recovery.service.js";
import { SHOPIFY_WEBHOOK_QUEUE_CONTRACTS } from "@modainteract/moda-interact-shared/shopify";
import { backgroundRuntimeConfigService } from "../runtime/background-runtime-config.js";
import { bindWorkerConcurrency } from "../runtime/queue-concurrency-controller.js";

const bullMQTelemetry = createBullMQTelemetry({
  serviceName: "moda-shopify-event-worker",
  enableMetrics: false,
});
const workerMetricDefinition = {
  workerName: "checkout",
  queueName: SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.queueName,
  jobNames: [
    SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.WHATSAPP_CONSENT_SYNC.jobName,
    SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.jobName,
    SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_UPDATED_EVENTS.jobName,
    SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CART_ACTIVITY_EVENTS.jobName,
  ],
} as const;

export function createCheckoutWorker() {
  const consentSynchroniser = new ShopifyWhatsAppConsentService();
  const logger = createLogger({
    serviceName: "moda-shopify-event-worker",
    environment: resolveDeploymentEnvironmentName(),
  });
  const handlers = {
    checkoutCreated: (input: Parameters<typeof checkoutRecoveryService.handleCheckoutCreatedContract>[0]) =>
      checkoutRecoveryService.handleCheckoutCreatedContract(input),
    checkoutUpdated: (input: Parameters<typeof checkoutRecoveryService.handleCheckoutUpdatedContract>[0]) =>
      checkoutRecoveryService.handleCheckoutUpdatedContract(input),
    cartActivity: (input: Parameters<typeof checkoutRecoveryService.handleCartActivityContract>[0]) =>
      checkoutRecoveryService.handleCartActivityContract(input),
    consentSync: (data: unknown) =>
      processShopifyWhatsAppConsentSyncJob(data, consentSynchroniser, logger),
  };
  const worker = new Worker<unknown>(
    SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.queueName,
    async (job) => observeWorkerJob(workerMetricDefinition, job, () => dispatchCheckoutQueueJob(job, handlers)),

    {
      connection: connectionRedis,
      telemetry: bullMQTelemetry,
    },
  );
  bindWorkerConcurrency(worker, backgroundRuntimeConfigService, "checkoutQueueGlobalConcurrency");
  worker.on("completed", (job) => {
    console.log(`Job ${job.id} completed successfully`);
  });
  
  worker.on("failed", (job, error) => {
    console.error(`Job ${job?.id} failed`, error);
  });
  
  worker.on("error", (error) => {
    console.error("Worker error", error);
  });
  
  console.log("Checkout worker started");
  return worker;
}