import { closeWorkerObservability } from "../runtime/observability.js";
import { startBillingReconciliationScheduler } from "../runtime/billing-scheduler.js";
import { startReadyWorkerProcess } from "../runtime/readiness.js";

void startReadyWorkerProcess({
  serviceName: "moda-billing-worker",
  loadWorkerProcess: async () => {
    const [{ closeBillingResources }, { billingReconciliationService }] = await Promise.all([
      import("./billing-resources.js"),
      import("../services/billing-reconciliation.service.js"),
    ]);
    await billingReconciliationService.reconcileOnce();
    const stopScheduler = startBillingReconciliationScheduler(
      () => billingReconciliationService.reconcileOnce(),
      60_000,
    );

    return {
      workers: [],
      closeResources: [
        async () => stopScheduler(),
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