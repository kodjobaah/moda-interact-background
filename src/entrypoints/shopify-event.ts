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
    const [{ closeWorkerResources }, { createCheckoutWorker }, { createOrderWorker }, { createWooCheckoutCaptureWorker }, { createWooOrderCaptureWorker }] =
      await Promise.all([
        import("./resources.js"),
        import("../workers/checkout.worker.js"),
        import("../workers/orders.worker.js"),
        import("../workers/woo-checkout-capture.worker.js"),
        import("../workers/woo-order-capture.worker.js"),
      ]);
    const { createWooRecoveryRuntime } = await import("../services/woocommerce-recovery/woo-recovery-composition.js");
    const wooRecovery = createWooRecoveryRuntime("moda-shopify-event-worker");
    const checkoutWorker = createCheckoutWorker();
    const orderWorker = createOrderWorker();
    const wooCheckoutCaptureWorker = createWooCheckoutCaptureWorker(wooRecovery.orchestrator);
    const wooOrderCaptureWorker = createWooOrderCaptureWorker(wooRecovery.orchestrator);
    const stopQueueConcurrencyController = await startQueueConcurrencyController({
      config: backgroundRuntimeConfigService,
      lease: backgroundRuntimeLeaseService,
    });

    const closeQueuePerformanceTelemetry = startQueuePerformanceTelemetry({
      connection: connectionRedis,
      queueNames: ["checkout-events", "order-events", "woo-checkout-capture-v1", "woo-order-capture-v1"],
    });

    return {
      workers: [checkoutWorker, orderWorker, wooCheckoutCaptureWorker, wooOrderCaptureWorker],
      closeResources: [stopQueueConcurrencyController, wooRecovery.close, () => backgroundRuntimeConfigService.close(), ...closeWorkerResources, closeWorkerObservability, closeQueuePerformanceTelemetry],
    };
  },
}).catch(reportReadinessFailure);

async function reportReadinessFailure(error: unknown): Promise<void> {
  console.error("worker readiness failed", error);
  await closeWorkerObservability();
  process.exitCode = 1;
}