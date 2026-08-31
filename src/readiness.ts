import {
  assertWorkerReady,
  createDependencyProbes,
  WORKER_DEPENDENCIES,
  type WorkerServiceName,
} from "./runtime/readiness.js";

const serviceName = process.argv[2];

if (!isWorkerServiceName(serviceName)) {
  console.error("Usage: node dist/readiness.js <worker-service-name>");
  process.exitCode = 2;
} else {
  void assertWorkerReady(serviceName, createDependencyProbes())
    .then(() => {
      console.log(`${serviceName} ready`);
    })
    .catch((error: unknown) => {
      console.error(
        error instanceof Error ? error.message : `${serviceName} readiness failed`,
      );
      process.exitCode = 1;
    });
}

function isWorkerServiceName(value: string | undefined): value is WorkerServiceName {
  return value !== undefined && value in WORKER_DEPENDENCIES;
}