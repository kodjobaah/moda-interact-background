import { startReadyWorkerProcess } from "../runtime/readiness.js";
import { closeWorkerObservability } from "../runtime/observability.js";
import { connectionRedis } from "../lib/redis.js";
import { startQueuePerformanceTelemetry } from "../observability/queue-performance.js";
import { backgroundRuntimeConfigService } from "../runtime/background-runtime-config.js";
import { backgroundRuntimeLeaseService } from "../runtime/background-runtime-lease.js";
import { startQueueConcurrencyController } from "../runtime/queue-concurrency-controller.js";
import { startHumanCommandDispatcher } from "../services/recovery-conversation/start-human-command-dispatcher.js";
import { startProductionMetaTemplateDuePoller } from "../services/meta-template-management/due-poller.js";

void startReadyWorkerProcess({
  serviceName: "moda-messaging-worker",
  loadWorkerProcess: async () => {
    await backgroundRuntimeConfigService.start();
    const [{ closeWorkerResources }, { createWhatsappWorker }] = await Promise.all([
      import("./resources.js"),
      import("../workers/whatsapp.worker.js"),
    ]);
    const whatsappWorker = createWhatsappWorker();
    const closeHumanDispatcher = await startHumanCommandDispatcher();
    const closeTemplateDuePoller = startProductionMetaTemplateDuePoller();
    const stopQueueConcurrencyController = await startQueueConcurrencyController({
      config: backgroundRuntimeConfigService,
      lease: backgroundRuntimeLeaseService,
    });

    const closeQueuePerformanceTelemetry = startQueuePerformanceTelemetry({
      connection: connectionRedis,
      queueNames: ["whatsapp-events"],
    });

    return {
      workers: [whatsappWorker],
      closeResources: [
        closeHumanDispatcher,
        closeTemplateDuePoller,
        ...closeWorkerResources,
        stopQueueConcurrencyController,
        () => backgroundRuntimeConfigService.close(),
        closeWorkerObservability,
        closeQueuePerformanceTelemetry,
      ],
    };
  },
}).catch(reportReadinessFailure);

async function reportReadinessFailure(error: unknown): Promise<void> {
  console.error("worker readiness failed", error);
  await closeWorkerObservability();
  process.exitCode = 1;
}