import { createLogger } from "@modainteract/moda-interact-shared/logging";

import { closeWorkerObservability } from "../runtime/observability.js";
import { startDynamicLeasedScheduler } from "../runtime/dynamic-leased-scheduler.js";
import { backgroundRuntimeConfigService } from "../runtime/background-runtime-config.js";
import { backgroundRuntimeLeaseService } from "../runtime/background-runtime-lease.js";
import type { BackgroundRuntimeConfigSnapshot } from "../runtime/background-runtime-config.js";
import { startReadyWorkerProcess } from "../runtime/readiness.js";
import { connectionRedis } from "../lib/redis.js";
import { startQueuePerformanceTelemetry, type QueueName } from "../observability/queue-performance.js";
import { startQueueConcurrencyController } from "../runtime/queue-concurrency-controller.js";

const logger = createLogger({
  serviceName: "moda-billing-worker",
  environment: process.env.NODE_ENV ?? "development",
});

function reportBillingReconciliationFailure(error: unknown): void {
  const message = error instanceof Error ? error.message.slice(0, 256) : "unknown failure";
  logger.error("billing.reconciliation.scan_failed", {
    errorName: error instanceof Error ? error.name.slice(0, 64) : "UnknownError",
    errorMessage: message,
  });
}

void startReadyWorkerProcess({
  serviceName: "moda-billing-worker",
  loadWorkerProcess: async () => {
    await backgroundRuntimeConfigService.start();
    const [
      { closeBillingResources, billingSubscriptionQueue },
      { createBillingReconciliationService },
      { RecoveryCreditRefundCorrectionService },
    ] = await Promise.all([
      import("./billing-resources.js"),
      import("../services/billing-reconciliation.service.js"),
      import("../services/recovery-credit-refund-correction.service.js"),
    ]);
    const [, { BillingSubscriptionReconciliationService }, { createBillingSubscriptionReconciliationWorker }] = await Promise.all([
      import("./billing-resources.js"),
      import("../services/billing-subscription-reconciliation.service.js"),
      import("../workers/billing-subscription-reconciliation.worker.js"),
    ]);
    const billingReconciliationService = createBillingReconciliationService(billingSubscriptionQueue);
    const recoveryCreditRefundCorrectionService = new RecoveryCreditRefundCorrectionService();
    const subscriptionReconciliation = new BillingSubscriptionReconciliationService(undefined, undefined, billingSubscriptionQueue);
    const billingSubscriptionReconciliationWorker = createBillingSubscriptionReconciliationWorker(subscriptionReconciliation);
    const stopQueueConcurrencyController = await startQueueConcurrencyController({
      config: backgroundRuntimeConfigService,
      lease: backgroundRuntimeLeaseService,
    });
    const stopQueuePerformanceTelemetry = startQueuePerformanceTelemetry({
      connection: connectionRedis,
      queueNames: [billingSubscriptionQueue.name as QueueName],
    });
    const runBillingCycle = async (runtimeConfig: BackgroundRuntimeConfigSnapshot) => {
      await billingReconciliationService.reconcileOnce(runtimeConfig);
  await recoveryCreditRefundCorrectionService.processDue();
      await subscriptionReconciliation.reconstruct();
    };
    const stopScheduler = await startDynamicLeasedScheduler({
      config: backgroundRuntimeConfigService,
      lease: backgroundRuntimeLeaseService,
      leaseName: "BILLING_RECONCILIATION",
      intervalMs: 0,
      runImmediately: true,
      getIntervalMs: (runtimeConfig) => runtimeConfig.billingReconciliationIntervalSeconds * 1000,
      run: runBillingCycle,
      onError: reportBillingReconciliationFailure,
    });

    return {
      workers: [billingSubscriptionReconciliationWorker],
      closeResources: [
        stopQueueConcurrencyController,
        async () => stopScheduler(),
        () => backgroundRuntimeConfigService.close(),
        stopQueuePerformanceTelemetry,
        ...closeBillingResources,
        closeWorkerObservability,
      ],
    };
  },
}).catch(reportReadinessFailure);

async function reportReadinessFailure(error: unknown): Promise<void> {
  console.error(error instanceof Error ? error.message : "worker readiness failed");
  await closeWorkerObservability();
  process.exitCode = 1;
}
