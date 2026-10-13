import { Worker, type Job } from "bullmq";
import { createLogger } from "@modainteract/moda-interact-shared/logging";

import { connectionRedis } from "../lib/redis.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { WooCouponCatalogueService } from "../services/woo-coupon-catalogue.service.js";
import {
  WOO_COUPON_SYNC_JOB_NAME,
  WOO_COUPON_SYNC_QUEUE_NAME,
  createWooCouponJobId,
} from "../services/woo-coupon-dispatcher.service.js";

const logger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

export interface WooCouponSyncJobData {
  shopId: string;
  requestedAt: string;
}

/** A private, bounded queue contract; do not accept URLs or credentials in jobs. */
export function parseWooCouponSyncJob(job: Pick<Job, "name" | "id" | "data">): {
  shopId: string;
  requestedAt: Date;
} {
  const value: unknown = job.data;
  if (job.name !== WOO_COUPON_SYNC_JOB_NAME ||
      !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Woo coupon synchronisation job");
  }
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== 2 ||
      typeof data.shopId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(data.shopId) ||
      typeof data.requestedAt !== "string" || data.requestedAt.length > 35 ||
      typeof job.id !== "string" || job.id !== createWooCouponJobId(data.shopId)) {
    throw new Error("Invalid Woo coupon synchronisation job");
  }
  const requestedAt = new Date(data.requestedAt);
  if (!Number.isFinite(requestedAt.getTime()) ||
      requestedAt.toISOString() !== data.requestedAt) {
    throw new Error("Invalid Woo coupon synchronisation job");
  }
  return { shopId: data.shopId, requestedAt };
}

export function wooCouponWorkerConcurrency(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.WOO_COUPON_SYNC_WORKER_CONCURRENCY;
  if (raw === undefined || raw === "") return 4;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new RangeError("WOO_COUPON_SYNC_WORKER_CONCURRENCY must be an integer from 1 to 32");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > 32) {
    throw new RangeError("WOO_COUPON_SYNC_WORKER_CONCURRENCY must be an integer from 1 to 32");
  }
  return parsed;
}

/**
 * Workers share one BullMQ queue but reconcile independent shop-scoped catalogues.
 * The catalogue service owns the durable per-shop claim and its generation fence.
 */
export function createWooCouponSyncWorker(
  catalogue: Pick<WooCouponCatalogueService, "reconcile"> = new WooCouponCatalogueService(),
  concurrency = wooCouponWorkerConcurrency(),
) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new RangeError("Woo coupon worker concurrency must be between 1 and 32");
  }
  const worker = new Worker<WooCouponSyncJobData>(
    WOO_COUPON_SYNC_QUEUE_NAME,
    async (job) => {
      const { shopId, requestedAt } = parseWooCouponSyncJob(job);
      const fields = {
        shopId,
        jobId: typeof job.id === "string" ? job.id.slice(0, 100) : null,
        attempt: job.attemptsMade + 1,
      };
      logger.info("woo.coupon_sync.received", fields);
      try {
        const outcome = await catalogue.reconcile(shopId, requestedAt);
        if (outcome === "current") logger.info("woo.coupon_sync.completed", { ...fields, outcome });
        else if (outcome === "unavailable") logger.warn("woo.coupon_sync.unavailable", { ...fields, outcome });
        else logger.info("woo.coupon_sync.skipped", { ...fields, outcome });
        // Unavailable / already-running / superseded are non-retryable outcomes.
        // The global dispatcher will revisit the shop after its cooldown.
        return outcome;
      } catch (error) {
        // Never log provider payloads or arbitrary error.message (which may
        // contain credential-bearing URLs in third-party transport failures).
        logger.error("woo.coupon_sync.failed", {
          ...fields,
          errorCode: error instanceof Error && error.name === "WooCouponReadError"
            ? String((error as Error & { code?: unknown }).code).slice(0, 64)
            : "woo_coupon_sync_error",
        });
        throw error; // BullMQ's bounded retry policy remains authoritative.
      }
    },
    { connection: connectionRedis, concurrency },
  );
  worker.on("ready", () => {
    logger.info("woo.coupon_sync.worker_ready", {
      queueName: WOO_COUPON_SYNC_QUEUE_NAME,
      concurrency,
    });
  });
  worker.on("error", (error) => {
    logger.error("woo.coupon_sync.worker_error", {
      queueName: WOO_COUPON_SYNC_QUEUE_NAME,
      errorName: error.name.slice(0, 64),
    });
  });
  return worker;
}
