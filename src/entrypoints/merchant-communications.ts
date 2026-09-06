import { startReadyWorkerProcess } from "../runtime/readiness.js";
import { closeWorkerObservability } from "../runtime/observability.js";
import { connectionRedis } from "../lib/redis.js";
import { startQueuePerformanceTelemetry } from "../observability/queue-performance.js";
import { reconciliationIntervalMs, translationReconciliationService } from "../services/translation-reconciliation.service.js";

void startReadyWorkerProcess({
  serviceName: "moda-merchant-communications-worker",
  loadWorkerProcess: async () => {
    const [{ closeWorkerResources }, { merchantCommunicationsWorker }] = await Promise.all([
      import("./resources.js"),
      import("../workers/merchant-communications.worker.js"),
    ]);

    await translationReconciliationService.reconcile();
    const interval = setInterval(() => {
      void translationReconciliationService.reconcile().catch((error: unknown) => {
        console.error("translation reconciliation failed", error);
      });
    }, reconciliationIntervalMs());
    interval.unref();

    const closeQueuePerformanceTelemetry = startQueuePerformanceTelemetry({
      connection: connectionRedis,
      queueNames: ["merchant-communications"],
    });

    return {
      workers: [merchantCommunicationsWorker],
      closeResources: [
        ...closeWorkerResources,
        async () => clearInterval(interval),
        () => translationReconciliationService.close(),
        closeWorkerObservability,
        closeQueuePerformanceTelemetry,
      ],
    };
  },
}).catch(reportReadinessFailure);

async function reportReadinessFailure(error: unknown): Promise<void> {
  console.error(error instanceof Error ? error.message : "worker readiness failed");
  await closeWorkerObservability();
  process.exitCode = 1;
}