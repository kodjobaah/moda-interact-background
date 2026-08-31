import { startReadyWorkerProcess } from "../runtime/readiness.js";
import { closeWorkerObservability } from "../runtime/observability.js";

void startReadyWorkerProcess({
  serviceName: "moda-shopify-event-worker",
  loadWorkerProcess: async () => {
    const [{ closeWorkerResources }, { checkoutWorker }, { orderWorker }] =
      await Promise.all([
        import("./resources.js"),
        import("../workers/checkout.worker.js"),
        import("../workers/orders.worker.js"),
      ]);

    return {
      workers: [checkoutWorker, orderWorker],
      closeResources: [...closeWorkerResources, closeWorkerObservability],
    };
  },
}).catch(reportReadinessFailure);

async function reportReadinessFailure(error: unknown): Promise<void> {
  console.error(error instanceof Error ? error.message : "worker readiness failed");
  await closeWorkerObservability();
  process.exitCode = 1;
}