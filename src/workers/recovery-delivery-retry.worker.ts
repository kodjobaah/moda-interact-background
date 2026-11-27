import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { InitialDeliveryRetryExecutionService, initialRetryExecutionPorts } from "../services/recovery-delivery-retry/execution.js";
import { RecoveryDeliveryRetrySweep, retryWorkerEnabled } from "../services/recovery-delivery-retry/sweep.js";
import { retrySweepLogger } from "../services/recovery-delivery-retry/sweep-logging.js";
import { ScheduledFollowUpRetryReconciliationService } from "../services/recovery-delivery-retry/follow-up-reconciliation.js";
import prisma from "../lib/db.js";

/** Explicit deployment opt-in; a missing value or typo cannot activate live
 * retries on either platform. Initial outreach is not controlled by this flag. */
export function createRecoveryDeliveryRetryWorker() {
  const log = createLogger({ serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName() });
  if (!retryWorkerEnabled(process.env.MODA_RECOVERY_DELIVERY_RETRY_ENABLED)) {
    log.info("recovery.delivery_retry.worker_disabled", { reason: "deployment-opt-in-required" });
    return null;
  }
  log.info("recovery.delivery_retry.worker_enabled", { platforms: ["SHOPIFY", "WOOCOMMERCE"] });
  const sweepLog = retrySweepLogger(log);
  const executor = new InitialDeliveryRetryExecutionService(prisma, initialRetryExecutionPorts(), sweepLog);
  const reconciler = new ScheduledFollowUpRetryReconciliationService(prisma, undefined, sweepLog);
  return new RecoveryDeliveryRetrySweep(executor, log, 60_000, 5, reconciler).start();
}
