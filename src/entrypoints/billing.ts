import { createLogger } from "@modainteract/moda-interact-shared/logging";

import { closeWorkerObservability } from "../runtime/observability.js";
import { startBillingReconciliationScheduler } from "../runtime/billing-scheduler.js";
import { startReadyWorkerProcess } from "../runtime/readiness.js";

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
    const [{ closeBillingResources }, { billingReconciliationService }, { subscriptionCancellationService }, { recoveryCreditRefundService }] = await Promise.all([
      import("./billing-resources.js"),
      import("../services/billing-reconciliation.service.js"),
      import("../services/subscription-cancellation.service.js"),
      import("../services/recovery-credit-refund.service.js"),
    ]);
    const runBillingCycle = async () => {
      await billingReconciliationService.reconcileOnce();
      await subscriptionCancellationService.processDue();
      await recoveryCreditRefundService.processDue();
    };
    await runBillingCycle();
    const stopScheduler = startBillingReconciliationScheduler(
      runBillingCycle,
      60_000,
      reportBillingReconciliationFailure,
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
