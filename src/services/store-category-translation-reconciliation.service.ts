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
import { ensureDeterministicTranslationQueueJob } from "./translation-batch-runtime/queue-job-repair.js";
import { routeTranslationBatchCorrelation } from "./translation-batch-runtime/provider-correlation.js";
import { StoreCategoryTranslationRunStateService } from "./store-category-translation/translation-run-state.service.js";
import { StoreCategoryTranslationBatchAssemblyService } from "./store-category-translation/translation-batch-assembly.service.js";

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
  private readonly runStateService: StoreCategoryTranslationRunStateService;
  private readonly batchAssemblyService: StoreCategoryTranslationBatchAssemblyService;

  constructor(options: {
    queue?: ReconciliationQueue;
    database?: ReconciliationDatabase;
    providerFactory?: ProviderFactory;
    runtimeConfig?: TranslationRuntimeConfigReader;
    credentialResolverFactory?: () => TranslationProviderCredentialResolver;
    runStateService?: StoreCategoryTranslationRunStateService;
    batchAssemblyService?: StoreCategoryTranslationBatchAssemblyService;
  } = {}) {
    this.queue = options.queue ?? new Queue(MERCHANT_COMMUNICATIONS_QUEUE_NAME, {
      connection: connectionRedis,
    });
    this.database = options.database ?? prisma;
    this.providerFactory = options.providerFactory ?? ((providerOptions) =>
      createOpenAITranslationProvider(providerOptions));
    this.runtimeConfig = options.runtimeConfig ?? backgroundRuntimeConfigService;
    this.credentialResolverFactory = options.credentialResolverFactory ?? defaultCredentialResolver;
    this.runStateService = options.runStateService ?? new StoreCategoryTranslationRunStateService(this.database);
    this.batchAssemblyService = options.batchAssemblyService ?? new StoreCategoryTranslationBatchAssemblyService(this.database);
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
      const assembled = await this.batchAssemblyService.assemble(
        run.id,
        snapshot.translationBatchMaxRequests,
      );
      if (assembled) {
        logger.info("background.store_category_translation.batch_assembled", {
          runId: run.id,
          batchId: assembled.batchId,
          provider: assembled.provider,
          model: assembled.model,
          itemCount: assembled.itemCount,
        });
        result.batchesAssembled += 1;
        result.repairedJobs += await this.ensureSubmitJob(assembled.batchId);
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

  private async advanceRunState(runId: string): Promise<"PROCESSING" | "READY_TO_PUBLISH" | "FAILED"> {
    const transition = await this.runStateService.advance(runId);
    if (transition.status === "FAILED") {
      logger.error("background.store_category_translation.run_failed", {
        runId,
        failureCode: transition.failureCode,
      });
      return "FAILED";
    }
    if (transition.status === "READY_TO_PUBLISH") {
      logger.info("background.store_category_translation.run_ready_to_publish", {
        runId,
        localeItemCount: transition.localeItemCount,
      });
      return "READY_TO_PUBLISH";
    }
    return "PROCESSING";
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

  private async ensureSubmitJob(batchId: string): Promise<number> {
    const job: StoreCategoryTranslationBatchSubmitJob = {
      schemaVersion: STORE_CATEGORY_TRANSLATION_SCHEMA_VERSION,
      translationBatchId: batchId,
    };
    return ensureDeterministicTranslationQueueJob(this.queue, {
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
    return ensureDeterministicTranslationQueueJob(this.queue, {
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
    return ensureDeterministicTranslationQueueJob(this.queue, {
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

    const route = routeTranslationBatchCorrelation(correlation.batch.status);
    if (route === "completed") {
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
}

export const storeCategoryTranslationReconciliationService =
  new StoreCategoryTranslationReconciliationService();
