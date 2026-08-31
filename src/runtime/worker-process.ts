export interface CloseableWorker {
  close(): Promise<void>;
}

export interface WorkerProcessOptions {
  serviceName: string;
  workers: readonly CloseableWorker[];
  closeResources: readonly (() => Promise<unknown>)[];
}

export function startWorkerProcess({
  serviceName,
  workers,
  closeResources,
}: WorkerProcessOptions): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (signal: NodeJS.Signals): Promise<void> => {
    shutdownPromise ??= performShutdown(
      serviceName,
      signal,
      workers,
      closeResources,
    ).finally(() => {
      process.off("SIGTERM", handleSignal);
      process.off("SIGINT", handleSignal);
    });

    return shutdownPromise;
  };

  const handleSignal = (signal: NodeJS.Signals) => {
    void shutdown(signal).catch((error: unknown) => {
      console.error(`${serviceName} shutdown failed`, error);
      process.exitCode = 1;
    });
  };

  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);

  console.log(`${serviceName} started`);

  return () => shutdown("SIGTERM");
}

async function performShutdown(
  serviceName: string,
  signal: NodeJS.Signals,
  workers: readonly CloseableWorker[],
  closeResources: readonly (() => Promise<unknown>)[],
): Promise<void> {
  console.log(`${signal} received, shutting down ${serviceName}`);

  const workerResults = await Promise.allSettled(
    workers.map((worker) => worker.close()),
  );
  const resourceResults = await Promise.allSettled(
    closeResources.map((closeResource) => closeResource()),
  );
  const failures = [...workerResults, ...resourceResults]
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);

  if (failures.length > 0) {
    throw new AggregateError(failures, `${serviceName} shutdown failed`);
  }

  console.log(`${serviceName} stopped`);
}