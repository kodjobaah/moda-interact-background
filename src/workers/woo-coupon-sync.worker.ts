import { Worker, type Job } from "bullmq";
import { createLogger } from "@modainteract/moda-interact-shared/logging";

import { connectionRedis } from "../lib/redis.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { WooCouponCatalogueService } from "../services/woo-coupon-catalogue.service.js";
import { WooCouponReaderService } from "../services/woo-coupon-reader.service.js";
import { WooCouponPageTransport, WooCouponReadError } from "../providers/woo-coupon-transport.js";
import { WooCouponGrantService } from "../services/woo-coupon-grant.service.js";
import { readWooCouponPolicy } from "../services/platform-configuration/consumers.js";
import {
  WOO_COUPON_SYNC_JOB_NAME,
  WOO_COUPON_SYNC_QUEUE_NAME,
  createWooCouponJobId,
} from "../services/woo-coupon-dispatcher.service.js";

const logger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

function boundedErrorMessage(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "unknown failure";
  return value;
}

function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "UnknownError";
}

function safeCauseField(error: unknown, key: "code" | "syscall"): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) ? value : undefined;
}

function wooCouponErrorFields(error: unknown) {
  const cause = error instanceof WooCouponReadError ? error.cause : undefined;
  const messageSource = cause instanceof Error ? cause : error;
  return {
    errorName: safeErrorName(error),
    errorMessage: error instanceof WooCouponReadError && error.message !== error.code
      ? error.message
      : boundedErrorMessage(messageSource instanceof Error ? messageSource.message : String(error)),
    ...(safeCauseField(cause, "code") ? { causeCode: safeCauseField(cause, "code") } : {}),
    ...(safeCauseField(cause, "syscall") ? { causeSyscall: safeCauseField(cause, "syscall") } : {}),
    ...(error instanceof WooCouponReadError && error.stage ? { errorStage: error.stage } : {}),
    ...(error instanceof WooCouponReadError && Number.isInteger(error.httpStatus)
      ? { httpStatus: error.httpStatus }
      : {}),
    ...(error instanceof WooCouponReadError && error.providerResponseBody !== undefined
      ? { providerResponseBody: error.providerResponseBody } : {}),
    ...(error instanceof WooCouponReadError && error.redirectLocation !== undefined
      ? { redirectLocation: error.redirectLocation } : {}),
  };
}

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
      typeof job.id !== "string") {
    throw new Error("Invalid Woo coupon synchronisation job");
  }
  const requestedAt = new Date(data.requestedAt);
  if (!Number.isFinite(requestedAt.getTime()) ||
      requestedAt.toISOString() !== data.requestedAt ||
      job.id !== createWooCouponJobId(data.shopId, data.requestedAt)) {
    throw new Error("Invalid Woo coupon synchronisation job");
  }
  return { shopId: data.shopId, requestedAt };
}

export function wooCouponWorkerConcurrency(environment: NodeJS.ProcessEnv): number {
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
const defaultWooCouponCatalogue = new WooCouponCatalogueService();
export function createWooCouponSyncWorker(
  catalogue: Pick<WooCouponCatalogueService, "reconcile"> = defaultWooCouponCatalogue,
  concurrency?: number,
) {
  if (typeof concurrency !== "number" || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
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
        // One fresh policy snapshot for this job; no captured environment values.
        const scoped = catalogue === defaultWooCouponCatalogue
          ? await (async () => {
              const settings = await readWooCouponPolicy();
              return new WooCouponCatalogueService(undefined, (shop) => new WooCouponReaderService(
                new WooCouponGrantService(), new WooCouponPageTransport(undefined, settings), settings,
              ).fetchAll(shop), undefined, settings);
            })()
          : catalogue;
        const outcome = await scoped.reconcile(shopId, requestedAt);
        if (outcome === "current") logger.info("woo.coupon_sync.completed", { ...fields, outcome });
        else if (outcome === "unavailable") logger.warn("woo.coupon_sync.unavailable", { ...fields, outcome });
        else logger.info("woo.coupon_sync.skipped", { ...fields, outcome });
        // Unavailable / already-running / superseded are non-retryable outcomes.
        // The global dispatcher will revisit the shop after its cooldown.
        return outcome;
      } catch (error) {
        logger.error("woo.coupon_sync.failed", {
          ...fields,
          errorCode: error instanceof Error && error.name === "WooCouponReadError"
            ? String((error as Error & { code?: unknown }).code).slice(0, 64)
            : "woo_coupon_sync_error",
          ...wooCouponErrorFields(error),
          error,
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
      ...wooCouponErrorFields(error),
      error,
    });
  });
  return worker;
}
