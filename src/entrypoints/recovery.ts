import { startReadyWorkerProcess } from "../runtime/readiness.js";
import { closeWorkerObservability } from "../runtime/observability.js";
import { connectionRedis } from "../lib/redis.js";
import { startQueuePerformanceTelemetry } from "../observability/queue-performance.js";
import { backgroundRuntimeConfigService } from "../runtime/background-runtime-config.js";
import { backgroundRuntimeLeaseService } from "../runtime/background-runtime-lease.js";
import { startDynamicLeasedScheduler } from "../runtime/dynamic-leased-scheduler.js";
import { startQueueConcurrencyController } from "../runtime/queue-concurrency-controller.js";
import { checkoutRecoveryExpiryService } from "../services/checkout-recovery-expiry.service.js";

void startReadyWorkerProcess({
  serviceName: "moda-recovery-worker",
  loadWorkerProcess: async () => {
    await backgroundRuntimeConfigService.start();
    const [{ closeWorkerResources }, { createPendingRecoveryCandidateWorker }, { createRecoveryCapacityResumeWorker }, { recoveryCapacityResumeService }] =
      await Promise.all([
        import("./resources.js"),
        import("../workers/pending-recovery-candidate.worker.js"),
        import("../workers/recovery-capacity-resume.worker.js"),
        import("../services/recovery-capacity-resume.service.js"),
      ]);
    const pendingRecoveryCandidateWorker = createPendingRecoveryCandidateWorker();
    const recoveryCapacityResumeWorker = createRecoveryCapacityResumeWorker();
    const stopQueueConcurrencyController = await startQueueConcurrencyController({
      config: backgroundRuntimeConfigService,
      lease: backgroundRuntimeLeaseService,
    });

    const stopRepairScheduler = await startDynamicLeasedScheduler({
      config: backgroundRuntimeConfigService,
      lease: backgroundRuntimeLeaseService,
      leaseName: "RECOVERY_CAPACITY_REPAIR",
      intervalMs: 5 * 60 * 1000,
      runImmediately: true,
      getIntervalMs: (runtimeConfig) => runtimeConfig.recoveryRepairIntervalSeconds * 1000,
      run: async (runtimeConfig) => { await recoveryCapacityResumeService.repair(runtimeConfig); },
      onError: (error) => { console.error("Recovery capacity repair failed", error); },
    });
    const stopExpiryScheduler = await startDynamicLeasedScheduler({
      config: backgroundRuntimeConfigService,
      lease: backgroundRuntimeLeaseService,
      leaseName: "CHECKOUT_RECOVERY_EXPIRY",
      intervalMs: 60 * 60 * 1000,
      runImmediately: true,
      run: async (runtimeConfig) => {
        await checkoutRecoveryExpiryService.expireInactive(runtimeConfig);
      },
      onError: (error) => { console.error("Checkout recovery expiry failed", error); },
    });

    const closeQueuePerformanceTelemetry = startQueuePerformanceTelemetry({
      connection: connectionRedis,
      queueNames: ["pending-recovery-candidates", "recovery-capacity-resume"],
    });

    return {
      workers: [pendingRecoveryCandidateWorker, recoveryCapacityResumeWorker],
      closeResources: [
        ...closeWorkerResources,
        stopQueueConcurrencyController,
        closeWorkerObservability,
        stopRepairScheduler,
        stopExpiryScheduler,
        () => backgroundRuntimeConfigService.close(),
        closeQueuePerformanceTelemetry,
        () => recoveryCapacityResumeService.close(),
      ],
    };
  },
}).catch(reportReadinessFailure);

async function reportReadinessFailure(error: unknown): Promise<void> {
  console.error(error instanceof Error ? error.message : "worker readiness failed");
  await closeWorkerObservability();
  process.exitCode = 1;
}