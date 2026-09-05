import { startReadyWorkerProcess } from "../runtime/readiness.js";
import { closeWorkerObservability } from "../runtime/observability.js";
import { connectionRedis } from "../lib/redis.js";
import { startQueuePerformanceTelemetry } from "../observability/queue-performance.js";

void startReadyWorkerProcess({
  serviceName: "moda-messaging-worker",
  loadWorkerProcess: async () => {
    const [{ closeWorkerResources }, { whatsappWorker }] = await Promise.all([
      import("./resources.js"),
      import("../workers/whatsapp.worker.js"),
    ]);

    const closeQueuePerformanceTelemetry = startQueuePerformanceTelemetry({
      connection: connectionRedis,
      queueNames: ["whatsapp-events"],
    });

    return {
      workers: [whatsappWorker],
      closeResources: [...closeWorkerResources, closeWorkerObservability, closeQueuePerformanceTelemetry],
    };
  },
}).catch(reportReadinessFailure);

async function reportReadinessFailure(error: unknown): Promise<void> {
  console.error(error instanceof Error ? error.message : "worker readiness failed");
  await closeWorkerObservability();
  process.exitCode = 1;
}