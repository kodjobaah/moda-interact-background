import { closeWorkerObservability } from "../runtime/observability.js";
import { startReadyWorkerProcess } from "../runtime/readiness.js";

const BILLING_SCAN_INTERVAL_MS = 60_000;

void startReadyWorkerProcess({
  serviceName: "moda-billing-worker",
  loadWorkerProcess: async () => {
    const [{ closeWorkerResources }, { billingReconciliationService }] = await Promise.all([
      import("./resources.js"),
      import("../services/billing-reconciliation.service.js"),
    ]);
    await billingReconciliationService.reconcileOnce();
    const interval = setInterval(() => {
      void billingReconciliationService.reconcileOnce().catch((error: unknown) => {
        console.error("billing reconciliation failed", error);
      });
    }, BILLING_SCAN_INTERVAL_MS);
    interval.unref();

    return {
      workers: [],
      closeResources: [
        async () => clearInterval(interval),
        ...closeWorkerResources,
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