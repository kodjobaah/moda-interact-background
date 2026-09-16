import { startReadyWorkerProcess } from "../runtime/readiness.js";
import { closeWorkerObservability } from "../runtime/observability.js";
import { connectionRedis } from "../lib/redis.js";
import { startQueuePerformanceTelemetry } from "../observability/queue-performance.js";
import { backgroundRuntimeConfigService } from "../runtime/background-runtime-config.js";
import { backgroundRuntimeLeaseService } from "../runtime/background-runtime-lease.js";
import { startDynamicLeasedScheduler } from "../runtime/dynamic-leased-scheduler.js";

void startReadyWorkerProcess({
  serviceName: "moda-recovery-worker",
  loadWorkerProcess: async () => {
    await backgroundRuntimeConfigService.start();
    const [{ closeWorkerResources }, { pendingRecoveryCandidateWorker }, { recoveryCapacityResumeWorker }, { recoveryCapacityResumeService }] =
      await Promise.all([
        import("./resources.js"),
        import("../workers/pending-recovery-candidate.worker.js"),
        import("../workers/recovery-capacity-resume.worker.js"),
        import("../services/recovery-capacity-resume.service.js"),
      ]);

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

    const closeQueuePerformanceTelemetry = startQueuePerformanceTelemetry({
      connection: connectionRedis,
      queueNames: ["pending-recovery-candidates", "recovery-capacity-resume"],
    });

    return {
      workers: [pendingRecoveryCandidateWorker, recoveryCapacityResumeWorker],
      closeResources: [
        ...closeWorkerResources,
        stopRepairScheduler,
        () => backgroundRuntimeConfigService.close(),
        closeWorkerObservability,
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