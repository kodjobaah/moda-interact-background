import { Prisma } from "@prisma/client";
import { Queue } from "bullmq";
import { CommerceEnvironmentSchema, type CommerceEnvironment } from "@modainteract/moda-interact-shared/commerce/model";
import { createLogger } from "@modainteract/moda-interact-shared/logging";

import {
  MERCHANT_PRICING_TRANSLATION_JOB_NAMES,
  MERCHANT_PRICING_TRANSLATION_SCHEMA_VERSION,
  createMerchantPricingTranslationBatchPollJobId,
  createMerchantPricingTranslationBatchResultsJobId,
  createMerchantPricingTranslationBatchSubmitJobId,
  type MerchantPricingTranslationBatchPollJob,
  type MerchantPricingTranslationBatchResultsJob,
  type MerchantPricingTranslationBatchSubmitJob,
} from "../domain/merchant-pricing-translation.js";
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
import { MerchantPricingTranslationRunStateService } from "./merchant-pricing-translation/translation-run-state.service.js";
import { MerchantPricingTranslationBatchAssemblyService } from "./merchant-pricing-translation/translation-batch-assembly.service.js";

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

export type MerchantPricingTranslationReconciliationResult = {
  runsStarted: number;
  batchesAssembled: number;
  repairedJobs: number;
  correlationConflicts: number;
  runsReadyToApply: number;
  runsFailed: number;
};

export class MerchantPricingTranslationReconciliationService {
  private readonly queue: ReconciliationQueue;
  private readonly database: ReconciliationDatabase;
  private readonly providerFactory: ProviderFactory;
  private readonly runtimeConfig: TranslationRuntimeConfigReader;
  private readonly credentialResolverFactory: () => TranslationProviderCredentialResolver;
  private readonly runStateService: MerchantPricingTranslationRunStateService;
  private readonly batchAssemblyService: MerchantPricingTranslationBatchAssemblyService;

  constructor(options: {
    queue?: ReconciliationQueue;
    database?: ReconciliationDatabase;
    providerFactory?: ProviderFactory;
    runtimeConfig?: TranslationRuntimeConfigReader;
    credentialResolverFactory?: () => TranslationProviderCredentialResolver;
    runStateService?: MerchantPricingTranslationRunStateService;
    batchAssemblyService?: MerchantPricingTranslationBatchAssemblyService;
  } = {}) {
    this.queue = options.queue ?? new Queue(MERCHANT_COMMUNICATIONS_QUEUE_NAME, {
      connection: connectionRedis,
    });
    this.database = options.database ?? prisma;
    this.providerFactory = options.providerFactory ?? ((providerOptions) =>
      createOpenAITranslationProvider(providerOptions));
    this.runtimeConfig = options.runtimeConfig ?? backgroundRuntimeConfigService;
    this.credentialResolverFactory = options.credentialResolverFactory ?? defaultCredentialResolver;
    this.runStateService = options.runStateService ?? new MerchantPricingTranslationRunStateService(this.database);
    this.batchAssemblyService = options.batchAssemblyService ?? new MerchantPricingTranslationBatchAssemblyService(this.database);
  }

  async reconcile(
    snapshot = currentTranslationRuntimeConfig(this.runtimeConfig),
  ): Promise<MerchantPricingTranslationReconciliationResult> {
    const result: MerchantPricingTranslationReconciliationResult = {
      runsStarted: 0,
      batchesAssembled: 0,
      repairedJobs: 0,
      correlationConflicts: 0,
      runsReadyToApply: 0,
      runsFailed: 0,
    };

    const startedRuns = await this.database.$queryRaw<Array<{ id: string; shopifyPlanHandle: string }>>(Prisma.sql`
      UPDATE "billing"."MerchantPricingTranslationRun"
      SET "status" = 'PROCESSING', "startedAt" = COALESCE("startedAt", NOW()), "updatedAt" = NOW()
      WHERE "id" IN (
        SELECT "id"
        FROM "billing"."MerchantPricingTranslationRun"
        WHERE "status" = 'PENDING'
        ORDER BY "requestedAt", "id"
        LIMIT ${snapshot.translationReconciliationPageSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "shopifyPlanHandle"
    `);
    result.runsStarted = startedRuns.length;
    for (const run of startedRuns) {
      logger.info("background.merchant_pricing_translation.run_started", {
        runId: run.id,
        shopifyPlanHandle: run.shopifyPlanHandle,
      });
    }

    const processingRuns = await this.database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "billing"."MerchantPricingTranslationRun"
      WHERE "status" = 'PROCESSING'
      ORDER BY "requestedAt", "id"
      LIMIT ${snapshot.translationReconciliationPageSize}
    `);
    for (const run of processingRuns) {
      const transition = await this.advanceRunState(run.id);
      if (transition === "READY_TO_APPLY") {
        result.runsReadyToApply += 1;
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
        logger.info("background.merchant_pricing_translation.batch_assembled", {
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
      if (correlation === "poll") {
        result.repairedJobs += await this.ensurePollJob({
          id: batch.id,
          pollSequence: Math.max(batch.pollSequence, 1),
        });
      }
    }

    const finalRuns = await this.database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "billing"."MerchantPricingTranslationRun"
      WHERE "status" = 'PROCESSING'
      ORDER BY "requestedAt", "id"
      LIMIT ${snapshot.translationReconciliationPageSize}
    `);
    for (const run of finalRuns) {
      const transition = await this.advanceRunState(run.id);
      if (transition === "READY_TO_APPLY") result.runsReadyToApply += 1;
      if (transition === "FAILED") result.runsFailed += 1;
    }

    return result;
  }

  async close(): Promise<void> {
    await this.queue.close?.();
  }

  private async advanceRunState(runId: string): Promise<"PROCESSING" | "READY_TO_APPLY" | "FAILED"> {
    const transition = await this.runStateService.advance(runId);
    if (transition.status === "FAILED") {
      logger.error("background.merchant_pricing_translation.run_failed", {
        runId,
        failureCode: transition.failureCode,
      });
      return "FAILED";
    }
    if (transition.status === "READY_TO_APPLY") {
      logger.info("background.merchant_pricing_translation.run_ready", {
        runId,
        itemCount: transition.itemCount,
      });
      return "READY_TO_APPLY";
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
      FROM "billing"."MerchantPricingTranslationBatch" b
      INNER JOIN "billing"."MerchantPricingTranslationRun" r ON r."id" = b."runId"
      WHERE b."status"::text = ${status}
        AND r."status" = 'PROCESSING'
        ${extra}
      ORDER BY b."createdAt", b."id"
      LIMIT ${limit}
    `);
  }

  private async ensureSubmitJob(batchId: string): Promise<number> {
    const job: MerchantPricingTranslationBatchSubmitJob = {
      schemaVersion: MERCHANT_PRICING_TRANSLATION_SCHEMA_VERSION,
      translationBatchId: batchId,
    };
    return ensureDeterministicTranslationQueueJob(this.queue, {
      id: createMerchantPricingTranslationBatchSubmitJobId(batchId),
      name: MERCHANT_PRICING_TRANSLATION_JOB_NAMES.BATCH_SUBMIT,
      data: job,
    });
  }

  private async ensurePollJob(batch: Pick<BatchRecoveryRow, "id" | "pollSequence">): Promise<number> {
    const job: MerchantPricingTranslationBatchPollJob = {
      schemaVersion: MERCHANT_PRICING_TRANSLATION_SCHEMA_VERSION,
      translationBatchId: batch.id,
      pollSequence: batch.pollSequence,
    };
    return ensureDeterministicTranslationQueueJob(this.queue, {
      id: createMerchantPricingTranslationBatchPollJobId(batch.id, batch.pollSequence),
      name: MERCHANT_PRICING_TRANSLATION_JOB_NAMES.BATCH_POLL,
      data: job,
    });
  }

  private async ensureResultsJob(batchId: string): Promise<number> {
    const job: MerchantPricingTranslationBatchResultsJob = {
      schemaVersion: MERCHANT_PRICING_TRANSLATION_SCHEMA_VERSION,
      translationBatchId: batchId,
    };
    return ensureDeterministicTranslationQueueJob(this.queue, {
      id: createMerchantPricingTranslationBatchResultsJobId(batchId),
      name: MERCHANT_PRICING_TRANSLATION_JOB_NAMES.BATCH_RESULTS,
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
      await this.database.$transaction(async (transaction) => {
        const changed = await transaction.$executeRaw(Prisma.sql`
          UPDATE "billing"."MerchantPricingTranslationBatch"
          SET "status" = 'FAILED', "failureCode" = 'CORRELATION_CONFLICT',
            "completedAt" = NOW(), "updatedAt" = NOW()
          WHERE "id" = ${batch.id} AND "status" = 'SUBMISSION_UNKNOWN'
        `);
        if (changed !== 1) return;
        await transaction.$executeRaw(Prisma.sql`
          UPDATE "billing"."MerchantPricingTranslationItem"
          SET "status" = 'FAILED', "currentBatchId" = NULL,
            "failureCode" = 'CORRELATION_CONFLICT', "nextAttemptAt" = NULL,
            "completedAt" = NOW(), "updatedAt" = NOW()
          WHERE "currentBatchId" = ${batch.id} AND "status" = 'PENDING'
        `);
      });
      return "conflict";
    }
    if (correlation.kind === "none") return "none";

    const route = routeTranslationBatchCorrelation(correlation.batch.status);
    if (route === "completed") {
      const changed = await this.database.$executeRaw(Prisma.sql`
        UPDATE "billing"."MerchantPricingTranslationBatch"
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
      UPDATE "billing"."MerchantPricingTranslationBatch"
      SET "providerBatchId" = ${correlation.batch.providerBatchId},
          "inputFileId" = COALESCE("inputFileId", ${correlation.batch.inputFileId}),
          "status" = 'SUBMITTED', "pollSequence" = GREATEST("pollSequence", 1),
          "nextPollAt" = NOW(), "failureCode" = NULL, "updatedAt" = NOW()
      WHERE "id" = ${batch.id} AND "status" = 'SUBMISSION_UNKNOWN'
    `);
    return changed === 1 ? "poll" : "stale";
  }
}

export const merchantPricingTranslationReconciliationService =
  new MerchantPricingTranslationReconciliationService();
