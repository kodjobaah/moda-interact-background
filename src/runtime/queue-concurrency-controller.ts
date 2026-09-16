import { Queue, type Worker } from "bullmq";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";

import { connectionRedis } from "../lib/redis.js";
import { MERCHANT_COMMUNICATIONS_QUEUE_NAME } from "../domain/translation-batch.js";
import { PENDING_RECOVERY_CANDIDATE_QUEUE } from "../domain/pending-recovery-candidate.js";
import { RECOVERY_CAPACITY_RESUME_QUEUE } from "../domain/recovery-capacity-resume.js";
import { BILLING_SUBSCRIPTION_RECONCILE_QUEUE_NAME } from "@modainteract/moda-interact-shared/billing";
import { SHOPIFY_WEBHOOK_QUEUE_CONTRACTS } from "@modainteract/moda-interact-shared/shopify";
import type { BackgroundRuntimeConfigService, BackgroundRuntimeConfigSnapshot } from "./background-runtime-config.js";
import type { BackgroundRuntimeLeaseService } from "./background-runtime-lease.js";

const RECONCILIATION_INTERVAL_MS = 30_000;
const logger = createLogger({ serviceName: "moda-background-queue-concurrency", environment: process.env.NODE_ENV ?? "development" });

export const CONTROLLED_QUEUE_DEFINITIONS = [
  [SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.queueName, "checkoutQueueGlobalConcurrency"],
  [SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS.queueName, "orderQueueGlobalConcurrency"],
  [PENDING_RECOVERY_CANDIDATE_QUEUE, "pendingRecoveryQueueGlobalConcurrency"],
  [RECOVERY_CAPACITY_RESUME_QUEUE, "recoveryResumeQueueGlobalConcurrency"],
  ["whatsapp-events", "whatsappQueueGlobalConcurrency"],
  [MERCHANT_COMMUNICATIONS_QUEUE_NAME, "merchantCommunicationsQueueGlobalConcurrency"],
  [BILLING_SUBSCRIPTION_RECONCILE_QUEUE_NAME, "billingSubscriptionQueueGlobalConcurrency"],
] as const satisfies readonly [string, keyof BackgroundRuntimeConfigSnapshot][];

type QueueDefinition = (typeof CONTROLLED_QUEUE_DEFINITIONS)[number];
type QueueLike = Pick<Queue, "setGlobalConcurrency" | "getGlobalConcurrency" | "close">;

export type QueueConcurrencyControllerOptions = {
  config: BackgroundRuntimeConfigService;
  lease: BackgroundRuntimeLeaseService;
  queues?: readonly QueueLike[];
  log?: StructuredLogger;
};

export function bindWorkerConcurrency<Key extends QueueDefinition[1]>(
  worker: Worker,
  config: BackgroundRuntimeConfigService,
  configKey: Key,
): () => void {
  let version = config.current().version;
  worker.concurrency = config.current()[configKey] as number;
  return config.subscribe((snapshot) => {
    if (snapshot.version <= version) return;
    version = snapshot.version;
    worker.concurrency = snapshot[configKey] as number;
  });
}

export async function startQueueConcurrencyController(
  options: QueueConcurrencyControllerOptions,
): Promise<() => Promise<void>> {
  options.config.current();
  const queues = options.queues ?? CONTROLLED_QUEUE_DEFINITIONS.map(([name]) => new Queue(name, { connection: connectionRedis }));
  const log = options.log ?? logger;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let pending = false;

  const schedule = (): void => {
    if (stopped || timer || running) return;
    timer = setTimeout(() => {
      timer = undefined;
      void reconcile().catch(() => undefined);
    }, RECONCILIATION_INTERVAL_MS);
    timer.unref();
  };

  const reconcile = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      pending = true;
      return;
    }
    running = options.lease.runWithLease("QUEUE_CONCURRENCY_RECONCILIATION", async () => {
      const snapshot = await options.config.getFresh();
      for (const [index, [queueName, configKey]] of CONTROLLED_QUEUE_DEFINITIONS.entries()) {
        const queue = queues[index];
        if (!queue) throw new Error(`Missing controlled queue at index ${index}.`);
        const desired = snapshot[configKey] as number;
        try {
          await queue.setGlobalConcurrency(desired);
          const actual = await queue.getGlobalConcurrency();
          if (actual !== desired) throw new Error(`expected ${desired}, got ${actual}`);
        } catch (error) {
          log.error("background.queue_concurrency.reconcile_failed", { queue: queueName, error });
          throw error;
        }
      }
    }).then(() => undefined).finally(() => {
      running = undefined;
      if (pending) {
        pending = false;
        void reconcile().catch(() => undefined);
      } else if (!stopped) schedule();
    });
    await running;
  };

  let observedVersion = options.config.current().version;
  const unsubscribe = options.config.subscribe((snapshot) => {
    if (snapshot.version <= observedVersion) return;
    observedVersion = snapshot.version;
    void reconcile().catch(() => undefined);
  });

  await reconcile().catch(() => undefined);
  schedule();

  return async () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    if (timer) clearTimeout(timer);
    timer = undefined;
    await running;
    if (!options.queues) await Promise.all(queues.map((queue) => queue.close()));
  };
}