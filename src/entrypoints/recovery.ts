import { startReadyWorkerProcess } from "../runtime/readiness.js";
import { closeWorkerObservability } from "../runtime/observability.js";

void startReadyWorkerProcess({
  serviceName: "moda-recovery-worker",
  loadWorkerProcess: async () => {
    const [{ closeWorkerResources }, { pendingRecoveryCandidateWorker }] =
      await Promise.all([
        import("./resources.js"),
        import("../workers/pending-recovery-candidate.worker.js"),
      ]);

    return {
      workers: [pendingRecoveryCandidateWorker],
      closeResources: [...closeWorkerResources, closeWorkerObservability],
    };
  },
}).catch(reportReadinessFailure);

async function reportReadinessFailure(error: unknown): Promise<void> {
  console.error(error instanceof Error ? error.message : "worker readiness failed");
  await closeWorkerObservability();
  process.exitCode = 1;
}