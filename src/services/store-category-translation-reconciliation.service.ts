import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import { Queue } from "bullmq";
import { CommerceEnvironmentSchema, type CommerceEnvironment } from "@modainteract/moda-interact-shared/commerce/model";
import { createLogger } from "@modainteract/moda-interact-shared/logging";

import {
  STORE_CATEGORY_TRANSLATION_JOB_NAMES,
  STORE_CATEGORY_TRANSLATION_SCHEMA_VERSION,
  createStoreCategoryTranslationBatchPollJobId,
  createStoreCategoryTranslationBatchResultsJobId,
  createStoreCategoryTranslationBatchSubmitJobId,
  type StoreCategoryTranslationBatchPollJob,
  type StoreCategoryTranslationBatchResultsJob,
  type StoreCategoryTranslationBatchSubmitJob,
} from "../domain/store-category-translation.js";
import { MERCHANT_COMMUNICATIONS_QUEUE_NAME } from "../domain/translation-batch.js";
import prisma from "../lib/db.js";
import { connectionRedis } from "../lib/redis.js";
import {
  createOpenAITranslationProvider,
  type TranslationProvider,
} from "../providers/translation.provider.js";
import { readCommerceCredentialKeyring } from "../commerce/credential-keyring.js";
import {
  createTranslationProviderCredentialResolver,
  type TranslationProviderCredentialResolver,
} from "../commerce/translation-provider-credential.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { backgroundRuntimeConfigService } from "../runtime/background-runtime-config.js";
import {
  currentTranslationRuntimeConfig,
  type TranslationRuntimeConfigReader,
} from "./translation-runtime-config.js";

const HEALTHY_STATES = new Set(["waiting", "delayed", "active"]);

const logger = createLogger({
  serviceName: "moda-merchant-communications-worker",
  environment: resolveDeploymentEnvironmentName(),
});

type ReconciliationQueue = Pick<Queue, "add" | "getJob"> & { close?: () => Promise<void> };
type ReconciliationDatabase = Pick<typeof prisma, "$queryRaw" | "$executeRaw" | "$transaction">;
type ProviderFactory = (options: { provider: string; model: string; apiKey: string }) => TranslationProvider;

type BatchRecoveryRow = {
  id: string;
  runId: string;
  environment: string;
  status: string;
  pollSequence: number;
  provider: string;
  model: string;
  inputFileId: string | null;
  providerBatchId: string | null;
  submissionStartedAt: Date | null;
  outputFileId: string | null;
  errorFileId: string | null;
};

type RunCounts = {
  total: bigint;
  available: bigint;
  failed: bigint;
  pending: bigint;
};

function defaultCredentialResolver(): TranslationProviderCredentialResolver {
  return createTranslationProviderCredentialResolver({
    db: prisma,
    keyring: readCommerceCredentialKeyring(),
  });
}

export type StoreCategoryTranslationReconciliationResult = {
  runsStarted: number;
  batchesAssembled: number;
  repairedJobs: number;
  correlationConflicts: number;
  runsReadyToPublish: number;
  runsFailed: number;
};

export class StoreCategoryTranslationReconciliationService {
  private readonly queue: ReconciliationQueue;
  private readonly database: ReconciliationDatabase;
  private readonly providerFactory: ProviderFactory;
  private readonly runtimeConfig: TranslationRuntimeConfigReader;
  private readonly credentialResolverFactory: () => TranslationProviderCredentialResolver;

  constructor(options: {
    queue?: ReconciliationQueue;
    database?: ReconciliationDatabase;
    providerFactory?: ProviderFactory;
    runtimeConfig?: TranslationRuntimeConfigReader;
    credentialResolverFactory?: () => TranslationProviderCredentialResolver;
  } = {}) {
    this.queue = options.queue ?? new Queue(MERCHANT_COMMUNICATIONS_QUEUE_NAME, {
      connection: connectionRedis,
    });
    this.database = options.database ?? prisma;
    this.providerFactory = options.providerFactory ?? ((providerOptions) =>
      createOpenAITranslationProvider(providerOptions));
    this.runtimeConfig = options.runtimeConfig ?? backgroundRuntimeConfigService;
    this.credentialResolverFactory = options.credentialResolverFactory ?? defaultCredentialResolver;
  }

  async reconcile(
    snapshot = currentTranslationRuntimeConfig(this.runtimeConfig),
  ): Promise<StoreCategoryTranslationReconciliationResult> {
    const result: StoreCategoryTranslationReconciliationResult = {
      runsStarted: 0,
      batchesAssembled: 0,
      repairedJobs: 0,
      correlationConflicts: 0,
      runsReadyToPublish: 0,
      runsFailed: 0,
    };

    const startedRuns = await this.database.$queryRaw<Array<{ id: string; categoryId: string }>>(Prisma.sql`
      UPDATE "commerce"."CommerceStoreCategoryTranslationRun"
      SET "status" = 'PROCESSING', "startedAt" = COALESCE("startedAt", NOW()), "updatedAt" = NOW()
      WHERE "id" IN (
        SELECT "id"
        FROM "commerce"."CommerceStoreCategoryTranslationRun"
        WHERE "status" = 'PENDING'
        ORDER BY "requestedAt", "id"
        LIMIT ${snapshot.translationReconciliationPageSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "categoryId"
    `);
    result.runsStarted = startedRuns.length;
    for (const run of startedRuns) {
      logger.info("background.store_category_translation.run_started", {
        runId: run.id,
        categoryId: run.categoryId,
      });
    }

    const processingRuns = await this.database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "commerce"."CommerceStoreCategoryTranslationRun"
      WHERE "status" = 'PROCESSING'
      ORDER BY "requestedAt", "id"
      LIMIT ${snapshot.translationReconciliationPageSize}
    `);
    for (const run of processingRuns) {
      const transition = await this.advanceRunState(run.id);
      if (transition === "READY_TO_PUBLISH") {
        result.runsReadyToPublish += 1;
        continue;
      }
      if (transition === "FAILED") {
        result.runsFailed += 1;
        continue;
      }
      const batchId = await this.assembleBatch(run.id, snapshot.translationBatchMaxRequests);
      if (batchId) {
        result.batchesAssembled += 1;
        result.repairedJobs += await this.ensureSubmitJob(batchId);
      }
    }

    const readyBatches = await this.loadRecoverableBatches("READY", snapshot.translationReconciliationPageSize, Prisma.sql`AND (b."nextSubmitAt" IS NULL OR b."nextSubmitAt" <= NOW())`);
    for (const batch of readyBatches) result.repairedJobs += await this.ensureSubmitJob(batch.id);

    const duePollBatches = await this.loadRecoverableBatches("SUBMITTED", snapshot.translationReconciliationPageSize, Prisma.sql`AND (b."nextPollAt" IS NULL OR b."nextPollAt" <= NOW())`);
    for (const batch of duePollBatches) result.repairedJobs += await this.ensurePollJob(batch);

    const completedBatches = await this.loadRecoverableBatches("PROVIDER_COMPLETED", snapshot.translationReconciliationPageSize);
    for (const batch of completedBatches) result.repairedJobs += await this.ensureResultsJob(batch.id);

    const unknownBatches = await this.loadRecoverableBatches("SUBMISSION_UNKNOWN", snapshot.translationReconciliationPageSize);
    for (const batch of unknownBatches) {
      const correlation = await this.reconcileUnknownBatch(batch, snapshot.translationClaimTimeoutSeconds);
      if (correlation === "conflict") result.correlationConflicts += 1;
      if (correlation === "completed") result.repairedJobs += await this.ensureResultsJob(batch.id);
      if (correlation === "poll") result.repairedJobs += await this.ensurePollJob(batch);
    }

    const finalRuns = await this.database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "commerce"."CommerceStoreCategoryTranslationRun"
      WHERE "status" = 'PROCESSING'
      ORDER BY "requestedAt", "id"
      LIMIT ${snapshot.translationReconciliationPageSize}
    `);
    for (const run of finalRuns) {
      const transition = await this.advanceRunState(run.id);
      if (transition === "READY_TO_PUBLISH") result.runsReadyToPublish += 1;
      if (transition === "FAILED") result.runsFailed += 1;
    }

    return result;
  }

  async close(): Promise<void> {
    await this.queue.close?.();
  }

  private async assembleBatch(runId: string, limit: number): Promise<string | null> {
    const assembled = await this.database.$transaction(async (transaction) => {
      const runs = await transaction.$queryRaw<Array<{ id: string; provider: string; providerModelId: string }>>(Prisma.sql`
        SELECT "id", "provider", "providerModelId"
        FROM "commerce"."CommerceStoreCategoryTranslationRun"
        WHERE "id" = ${runId} AND "status" = 'PROCESSING'
        FOR UPDATE
      `);
      const run = runs[0];
      if (!run) return null;

      const candidates = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "commerce"."CommerceStoreCategoryTranslationItem"
        WHERE "runId" = ${runId}
          AND "status" = 'PENDING'
          AND "currentBatchId" IS NULL
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW())
        ORDER BY "createdAt", "id"
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      `);
      if (candidates.length === 0) return null;

      const batchId = randomUUID();
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO "commerce"."CommerceStoreCategoryTranslationBatch" (
          "id", "runId", "provider", "model", "status", "updatedAt"
        ) VALUES (
          ${batchId}, ${runId}, ${run.provider}, ${run.providerModelId}, 'READY', NOW()
        )
      `);

      for (const candidate of candidates) {
        const providerCustomId = `store-category-${candidate.id}-${batchId}`;
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO "commerce"."CommerceStoreCategoryTranslationBatchItem" (
            "id", "batchId", "translationItemId", "providerCustomId"
          ) VALUES (
            ${randomUUID()}, ${batchId}, ${candidate.id}, ${providerCustomId}
          )
        `);
        await transaction.$executeRaw(Prisma.sql`
          UPDATE "commerce"."CommerceStoreCategoryTranslationItem"
          SET "currentBatchId" = ${batchId}, "updatedAt" = NOW()
          WHERE "id" = ${candidate.id}
            AND "status" = 'PENDING'
            AND "currentBatchId" IS NULL
        `);
      }
      return { batchId, itemCount: candidates.length, provider: run.provider, model: run.providerModelId };
    });

    if (assembled) {
      logger.info("background.store_category_translation.batch_assembled", {
        runId,
        batchId: assembled.batchId,
        provider: assembled.provider,
        model: assembled.model,
        itemCount: assembled.itemCount,
      });
    }
    return assembled?.batchId ?? null;
  }

  private async advanceRunState(runId: string): Promise<"PROCESSING" | "READY_TO_PUBLISH" | "FAILED"> {
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<RunCounts[]>(Prisma.sql`
        SELECT
          COUNT(*)::bigint AS "total",
          COUNT(*) FILTER (WHERE "status" = 'AVAILABLE')::bigint AS "available",
          COUNT(*) FILTER (WHERE "status" = 'FAILED')::bigint AS "failed",
          COUNT(*) FILTER (WHERE "status" = 'PENDING')::bigint AS "pending"
        FROM "commerce"."CommerceStoreCategoryTranslationItem"
        WHERE "runId" = ${runId}
      `);
      const count = rows[0];
      if (!count || Number(count.total) === 0) return "PROCESSING";

      if (Number(count.failed) > 0) {
        const changed = await transaction.$executeRaw(Prisma.sql`
          UPDATE "commerce"."CommerceStoreCategoryTranslationRun"
          SET "status" = 'FAILED', "failureCode" = 'TRANSLATION_ITEM_FAILED',
            "completedAt" = NOW(), "updatedAt" = NOW()
          WHERE "id" = ${runId} AND "status" = 'PROCESSING'
        `);
        if (changed === 1) {
          logger.error("background.store_category_translation.run_failed", {
            runId,
            failureCode: "TRANSLATION_ITEM_FAILED",
          });
          return "FAILED";
        }
      }

      if (
        Number(count.available) === Number(count.total) &&
        Number(count.pending) === 0
      ) {
        const changed = await transaction.$executeRaw(Prisma.sql`
          UPDATE "commerce"."CommerceStoreCategoryTranslationRun"
          SET "status" = 'READY_TO_PUBLISH', "readyToPublishAt" = NOW(),
            "failureCode" = NULL, "updatedAt" = NOW()
          WHERE "id" = ${runId} AND "status" = 'PROCESSING'
        `);
        if (changed === 1) {
          logger.info("background.store_category_translation.run_ready_to_publish", {
            runId,
            localeItemCount: Number(count.total),
          });
          return "READY_TO_PUBLISH";
        }
      }
      return "PROCESSING";
    });
  }

  private async loadRecoverableBatches(
    status: string,
    limit: number,
    extra: Prisma.Sql = Prisma.empty,
  ): Promise<BatchRecoveryRow[]> {
    return this.database.$queryRaw<BatchRecoveryRow[]>(Prisma.sql`
      SELECT b."id", b."runId", r."environment"::text AS "environment",
        b."status"::text AS "status", b."pollSequence", b."provider", b."model",
        b."inputFileId", b."providerBatchId", b."submissionStartedAt",
        b."outputFileId", b."errorFileId"
      FROM "commerce"."CommerceStoreCategoryTranslationBatch" b
      INNER JOIN "commerce"."CommerceStoreCategoryTranslationRun" r ON r."id" = b."runId"
      WHERE b."status"::text = ${status}
        AND r."status" = 'PROCESSING'
        ${extra}
      ORDER BY b."createdAt", b."id"
      LIMIT ${limit}
    `);
  }

  private async ensureJob(input: { id: string; name: string; data: unknown }): Promise<number> {
    const existing = await this.queue.getJob(input.id);
    if (existing) {
      const state = await existing.getState();
      if (HEALTHY_STATES.has(state)) return 0;
      await existing.remove();
    }
    await this.queue.add(input.name, input.data, { jobId: input.id });
    return 1;
  }

  private async ensureSubmitJob(batchId: string): Promise<number> {
    const job: StoreCategoryTranslationBatchSubmitJob = {
      schemaVersion: STORE_CATEGORY_TRANSLATION_SCHEMA_VERSION,
      translationBatchId: batchId,
    };
    return this.ensureJob({
      id: createStoreCategoryTranslationBatchSubmitJobId(batchId),
      name: STORE_CATEGORY_TRANSLATION_JOB_NAMES.BATCH_SUBMIT,
      data: job,
    });
  }

  private async ensurePollJob(batch: Pick<BatchRecoveryRow, "id" | "pollSequence">): Promise<number> {
    const job: StoreCategoryTranslationBatchPollJob = {
      schemaVersion: STORE_CATEGORY_TRANSLATION_SCHEMA_VERSION,
      translationBatchId: batch.id,
      pollSequence: batch.pollSequence,
    };
    return this.ensureJob({
      id: createStoreCategoryTranslationBatchPollJobId(batch.id, batch.pollSequence),
      name: STORE_CATEGORY_TRANSLATION_JOB_NAMES.BATCH_POLL,
      data: job,
    });
  }

  private async ensureResultsJob(batchId: string): Promise<number> {
    const job: StoreCategoryTranslationBatchResultsJob = {
      schemaVersion: STORE_CATEGORY_TRANSLATION_SCHEMA_VERSION,
      translationBatchId: batchId,
    };
    return this.ensureJob({
      id: createStoreCategoryTranslationBatchResultsJobId(batchId),
      name: STORE_CATEGORY_TRANSLATION_JOB_NAMES.BATCH_RESULTS,
      data: job,
    });
  }

  private async reconcileUnknownBatch(
    batch: BatchRecoveryRow,
    claimTimeoutSeconds: number,
  ): Promise<"poll" | "completed" | "none" | "conflict" | "stale"> {
    const environment = CommerceEnvironmentSchema.parse(batch.environment) as CommerceEnvironment;
    const apiKey = await this.credentialResolverFactory().resolve({
      environment,
      provider: batch.provider,
    });
    const provider = this.providerFactory({ provider: batch.provider, model: batch.model, apiKey });
    const submittedAfter = batch.submissionStartedAt
      ? new Date(batch.submissionStartedAt.getTime() - claimTimeoutSeconds * 1000)
      : undefined;
    const correlation = await provider.findBatchByCorrelation({
      logicalBatchId: batch.id,
      ...(batch.inputFileId ? { inputFileId: batch.inputFileId } : {}),
      ...(submittedAfter ? { submittedAfter } : {}),
    });
    if (correlation.kind === "conflict") {
      await this.database.$executeRaw(Prisma.sql`
        UPDATE "commerce"."CommerceStoreCategoryTranslationBatch"
        SET "failureCode" = 'CORRELATION_CONFLICT', "updatedAt" = NOW()
        WHERE "id" = ${batch.id} AND "status" = 'SUBMISSION_UNKNOWN'
      `);
      return "conflict";
    }
    if (correlation.kind === "none") return "none";

    if (correlation.batch.status === "completed") {
      const changed = await this.database.$executeRaw(Prisma.sql`
        UPDATE "commerce"."CommerceStoreCategoryTranslationBatch"
        SET "providerBatchId" = ${correlation.batch.providerBatchId},
            "inputFileId" = COALESCE("inputFileId", ${correlation.batch.inputFileId}),
            "outputFileId" = ${correlation.batch.outputFileId},
            "errorFileId" = ${correlation.batch.errorFileId},
            "status" = 'PROVIDER_COMPLETED',
            "failureCode" = NULL,
            "updatedAt" = NOW()
        WHERE "id" = ${batch.id} AND "status" = 'SUBMISSION_UNKNOWN'
      `);
      return changed === 1 ? "completed" : "stale";
    }

    if (correlation.batch.status === "nonterminal") {
      const changed = await this.database.$executeRaw(Prisma.sql`
        UPDATE "commerce"."CommerceStoreCategoryTranslationBatch"
        SET "providerBatchId" = ${correlation.batch.providerBatchId},
            "inputFileId" = COALESCE("inputFileId", ${correlation.batch.inputFileId}),
            "status" = 'SUBMITTED', "nextPollAt" = NOW(), "failureCode" = NULL,
            "updatedAt" = NOW()
        WHERE "id" = ${batch.id} AND "status" = 'SUBMISSION_UNKNOWN'
      `);
      return changed === 1 ? "poll" : "stale";
    }

    const terminalCode = correlation.batch.failureCode ?? correlation.batch.status;
    const terminalStatus = correlation.batch.status.toUpperCase();
    const changed = await this.database.$executeRaw(Prisma.sql`
      UPDATE "commerce"."CommerceStoreCategoryTranslationBatch"
      SET "providerBatchId" = ${correlation.batch.providerBatchId},
          "inputFileId" = COALESCE("inputFileId", ${correlation.batch.inputFileId}),
          "status" = CAST(${terminalStatus} AS "commerce"."CommerceStoreCategoryTranslationBatchStatus"),
          "failureCode" = ${terminalCode}, "completedAt" = NOW(), "updatedAt" = NOW()
      WHERE "id" = ${batch.id} AND "status" = 'SUBMISSION_UNKNOWN'
    `);
    if (changed !== 1) return "stale";
    await this.database.$executeRaw(Prisma.sql`
      UPDATE "commerce"."CommerceStoreCategoryTranslationItem"
      SET "status" = 'FAILED', "currentBatchId" = NULL,
          "failureCode" = ${terminalCode}, "nextAttemptAt" = NULL, "updatedAt" = NOW()
      WHERE "currentBatchId" = ${batch.id} AND "status" = 'PENDING'
    `);
    return "stale";
  }
}

export const storeCategoryTranslationReconciliationService =
  new StoreCategoryTranslationReconciliationService();
