import { startReadyWorkerProcess } from "../runtime/readiness.js";
import { closeWorkerObservability } from "../runtime/observability.js";
import { connectionRedis } from "../lib/redis.js";
import { startQueuePerformanceTelemetry } from "../observability/queue-performance.js";
import { recoveryCapacityResumeService } from "../services/recovery-capacity-resume.service.js";

void startReadyWorkerProcess({
  serviceName: "moda-recovery-worker",
  loadWorkerProcess: async () => {
    const [{ closeWorkerResources }, { pendingRecoveryCandidateWorker }, { recoveryCapacityResumeWorker }] =
      await Promise.all([
        import("./resources.js"),
        import("../workers/pending-recovery-candidate.worker.js"),
        import("../workers/recovery-capacity-resume.worker.js"),
      ]);

    await recoveryCapacityResumeService.repair();
    const repairInterval = setInterval(() => {
      void recoveryCapacityResumeService.repair();
    }, 5 * 60 * 1000);

    const closeQueuePerformanceTelemetry = startQueuePerformanceTelemetry({
      connection: connectionRedis,
      queueNames: ["pending-recovery-candidates", "recovery-capacity-resume"],
    });

    return {
      workers: [pendingRecoveryCandidateWorker, recoveryCapacityResumeWorker],
      closeResources: [
        ...closeWorkerResources,
        closeWorkerObservability,
        closeQueuePerformanceTelemetry,
        async () => { clearInterval(repairInterval); },
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