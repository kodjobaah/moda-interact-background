import { startReadyWorkerProcess } from "../runtime/readiness.js";
import { closeWorkerObservability } from "../runtime/observability.js";
import { connectionRedis } from "../lib/redis.js";
import { startQueuePerformanceTelemetry } from "../observability/queue-performance.js";
import { backgroundRuntimeConfigService } from "../runtime/background-runtime-config.js";
import { backgroundRuntimeLeaseService } from "../runtime/background-runtime-lease.js";
import { startQueueConcurrencyController } from "../runtime/queue-concurrency-controller.js";

void startReadyWorkerProcess({
  serviceName: "moda-shopify-event-worker",
  loadWorkerProcess: async () => {
    await backgroundRuntimeConfigService.start();
    const [{ closeWorkerResources }, { createCheckoutWorker }, { createOrderWorker }] =
      await Promise.all([
        import("./resources.js"),
        import("../workers/checkout.worker.js"),
        import("../workers/orders.worker.js"),
      ]);
    const checkoutWorker = createCheckoutWorker();
    const orderWorker = createOrderWorker();
    const stopQueueConcurrencyController = await startQueueConcurrencyController({
      config: backgroundRuntimeConfigService,
      lease: backgroundRuntimeLeaseService,
    });

    const closeQueuePerformanceTelemetry = startQueuePerformanceTelemetry({
      connection: connectionRedis,
      queueNames: ["checkout-events", "order-events"],
    });

    return {
      workers: [checkoutWorker, orderWorker],
      closeResources: [stopQueueConcurrencyController, () => backgroundRuntimeConfigService.close(), ...closeWorkerResources, closeWorkerObservability, closeQueuePerformanceTelemetry],
    };
  },
}).catch(reportReadinessFailure);

async function reportReadinessFailure(error: unknown): Promise<void> {
  console.error(error instanceof Error ? error.message : "worker readiness failed");
  await closeWorkerObservability();
  process.exitCode = 1;
}