import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";

import type { CloseableWorker } from "./worker-process.js";
import { startWorkerProcess } from "./worker-process.js";

export const WORKER_DEPENDENCIES = {
  "moda-shopify-event-worker": ["redis", "postgresql"],
  "moda-recovery-worker": ["redis", "postgresql"],
  "moda-messaging-worker": ["redis", "postgresql"],
} as const;

export type WorkerServiceName = keyof typeof WORKER_DEPENDENCIES;
export type DependencyName = (typeof WORKER_DEPENDENCIES)[WorkerServiceName][number];

export interface ReadinessProbe {
  name: DependencyName;
  check(): Promise<void>;
}

export interface LoadedWorkerProcess {
  workers: readonly CloseableWorker[];
  closeResources: readonly (() => Promise<unknown>)[];
}

export interface ReadyWorkerProcessOptions {
  serviceName: WorkerServiceName;
  loadWorkerProcess(): Promise<LoadedWorkerProcess>;
  probes?: readonly ReadinessProbe[];
}

const DEFAULT_TIMEOUT_MS = 5_000;

export async function assertWorkerReady(
  serviceName: WorkerServiceName,
  probes: readonly ReadinessProbe[],
): Promise<void> {
  const requiredDependencies = WORKER_DEPENDENCIES[serviceName];

  for (const dependency of requiredDependencies) {
    const probe = probes.find((candidate) => candidate.name === dependency);

    if (!probe) {
      throw new Error(`${serviceName} readiness failed: ${dependency} probe unavailable`);
    }

    try {
      await probe.check();
    } catch {
      throw new Error(`${serviceName} readiness failed: ${dependency} unavailable`);
    }
  }
}

export async function startReadyWorkerProcess({
  serviceName,
  loadWorkerProcess,
  probes = createDependencyProbes(),
}: ReadyWorkerProcessOptions): Promise<() => Promise<void>> {
  await assertWorkerReady(serviceName, probes);
  const { workers, closeResources } = await loadWorkerProcess();

  return startWorkerProcess({ serviceName, workers, closeResources });
}

export function createDependencyProbes(
  environment: NodeJS.ProcessEnv = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): readonly ReadinessProbe[] {
  return [
    {
      name: "redis",
      check: () => probeRedis(environment.REDIS_URL, timeoutMs),
    },
    {
      name: "postgresql",
      check: () => probePostgreSQL(environment.DATABASE_URL, timeoutMs),
    },
  ];
}

async function probeRedis(
  redisUrl: string | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!redisUrl) {
    throw new Error("missing Redis configuration");
  }

  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: timeoutMs,
    commandTimeout: timeoutMs,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
  });
  redis.on("error", () => undefined);

  try {
    await withTimeout(
      redis.connect().then(() => redis.ping()).then(() => undefined),
      timeoutMs,
    );
  } finally {
    redis.disconnect(false);
  }
}

async function probePostgreSQL(
  databaseUrl: string | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!databaseUrl) {
    throw new Error("missing PostgreSQL configuration");
  }

  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });

  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, timeoutMs);
  } finally {
    await prisma.$disconnect();
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("dependency probe timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}