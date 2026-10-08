import { Queue } from "bullmq";
import { Prisma } from "@prisma/client";
import { CommerceEnvironmentSchema, type CommerceEnvironment } from "@modainteract/moda-interact-shared/commerce/model";
import { createLogger } from "@modainteract/moda-interact-shared/logging";

import {
  STORE_CATEGORY_TRANSLATION_JOB_NAMES,
  STORE_CATEGORY_TRANSLATION_SCHEMA_VERSION,
  createStoreCategoryTranslationBatchPollJobId,
  type StoreCategoryTranslationBatchPollJob,
} from "../domain/store-category-translation.js";
import {
  createOpenAITranslationProvider,
  type TranslationProvider,
  type TranslationRequest,
} from "../providers/translation.provider.js";
import prisma from "../lib/db.js";
import { connectionRedis } from "../lib/redis.js";
import { readCommerceCredentialKeyring } from "../commerce/credential-keyring.js";
import {
  createTranslationProviderCredentialResolver,
  type TranslationProviderCredentialResolver,
} from "../commerce/translation-provider-credential.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import {
  backgroundRuntimeConfigService,
  type BackgroundRuntimeConfigSnapshot,
} from "../runtime/background-runtime-config.js";
import {
  currentTranslationRuntimeConfig,
  type TranslationRuntimeConfigReader,
} from "./translation-runtime-config.js";
import { MERCHANT_COMMUNICATIONS_QUEUE_NAME } from "../domain/translation-batch.js";
import {
  classifyTranslationSubmissionFailure,
  translationSubmissionFailureCode,
  type TranslationSubmitFailureClassification,
} from "./translation-batch-runtime/failure-policy.js";

export type StoreCategorySubmitFailureClassification = TranslationSubmitFailureClassification;

type BatchToSubmit = {
  id: string;
  runId: string;
  environment: string;
  provider: string;
  model: string;
  inputFileId: string | null;
  submitAttemptCount: number;
};

type BatchItemRequest = TranslationRequest & {
  providerCustomId: string;
};

type SubmissionTransaction = {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
};

type SubmissionDatabase = {
  $transaction<T>(callback: (transaction: SubmissionTransaction) => Promise<T>): Promise<T>;
};

type SubmissionQueue = Pick<Queue, "add">;

type ProviderFactory = (options: {
  provider: string;
  model: string;
  apiKey: string;
}) => TranslationProvider;

const logger = createLogger({
  serviceName: "moda-merchant-communications-worker",
  environment: resolveDeploymentEnvironmentName(),
});

function defaultCredentialResolver(): TranslationProviderCredentialResolver {
  return createTranslationProviderCredentialResolver({
    db: prisma,
    keyring: readCommerceCredentialKeyring(),
  });
}

export type StoreCategoryTranslationBatchSubmitResult =
  | { status: "claimed"; batchId: string; providerBatchId: string }
  | { status: "skipped"; batchId: string };

export class StoreCategoryTranslationBatchSubmitService {
  private readonly database: SubmissionDatabase;
  private readonly providerFactory: ProviderFactory;
  private readonly queue: SubmissionQueue;
  private readonly runtimeConfig: TranslationRuntimeConfigReader;
  private readonly credentialResolverFactory: () => TranslationProviderCredentialResolver;

  constructor(options: {
    database?: SubmissionDatabase;
    providerFactory?: ProviderFactory;
    queue?: SubmissionQueue;
    runtimeConfig?: TranslationRuntimeConfigReader;
    credentialResolverFactory?: () => TranslationProviderCredentialResolver;
  } = {}) {
    this.database = options.database ?? prisma;
    this.providerFactory = options.providerFactory ?? ((providerOptions) =>
      createOpenAITranslationProvider(providerOptions));
    this.queue = options.queue ?? new Queue(MERCHANT_COMMUNICATIONS_QUEUE_NAME, {
      connection: connectionRedis,
    });
    this.runtimeConfig = options.runtimeConfig ?? backgroundRuntimeConfigService;
    this.credentialResolverFactory = options.credentialResolverFactory ?? defaultCredentialResolver;
  }

  async submit(input: { translationBatchId: string }): Promise<StoreCategoryTranslationBatchSubmitResult> {
    const startedAt = Date.now();
    const claimed = await this.claimReadyBatch(input.translationBatchId);
    if (!claimed) return { status: "skipped", batchId: input.translationBatchId };
    const runtimeConfig = currentTranslationRuntimeConfig(this.runtimeConfig);

    let provider: TranslationProvider;
    try {
      const environment = CommerceEnvironmentSchema.parse(claimed.environment) as CommerceEnvironment;
      const apiKey = await this.credentialResolverFactory().resolve({
        environment,
        provider: claimed.provider,
      });
      provider = this.providerFactory({
        provider: claimed.provider,
        model: claimed.model,
        apiKey,
      });
    } catch (error) {
      await this.persistFailure(claimed, "DEFINITE_TERMINAL_NOT_CREATED", error, runtimeConfig);
      logger.error("background.store_category_translation.batch_submit_failed", {
        runId: claimed.runId,
        batchId: claimed.id,
        provider: claimed.provider,
        model: claimed.model,
        failureCode: translationSubmissionFailureCode(error),
        durationMs: Date.now() - startedAt,
      });
      return { status: "skipped", batchId: claimed.id };
    }

    let inputFileId = claimed.inputFileId;
    try {
      if (!inputFileId) {
        try {
          const requests = await this.loadRequests(claimed.id);
          const prepared = await provider.prepareBatchInput(requests);
          inputFileId = prepared.inputFileId;
          await this.persistInputFileId(claimed.id, prepared.inputFileId);
        } catch (error) {
          await this.persistFailure(
            claimed,
            classifyTranslationSubmissionFailure(error, "DEFINITE_RETRYABLE_NOT_CREATED"),
            error,
            runtimeConfig,
          );
          return { status: "skipped", batchId: claimed.id };
        }
      }

      if (!inputFileId) {
        throw new Error("Store Category translation Batch input file is unavailable");
      }
      const resolvedInputFileId = inputFileId;
      const providerBatch = await provider.createBatch(claimed.id, resolvedInputFileId);
      await this.persistSubmitted(
        claimed.id,
        providerBatch.providerBatchId,
        resolvedInputFileId,
        runtimeConfig,
      );
      await this.enqueuePoll(claimed.id, 1, runtimeConfig);
      logger.info("background.store_category_translation.batch_submitted", {
        runId: claimed.runId,
        batchId: claimed.id,
        provider: claimed.provider,
        model: claimed.model,
        durationMs: Date.now() - startedAt,
      });
      return {
        status: "claimed",
        batchId: claimed.id,
        providerBatchId: providerBatch.providerBatchId,
      };
    } catch (error) {
      const classification = classifyTranslationSubmissionFailure(error, "AMBIGUOUS_CREATE");
      await this.persistFailure(claimed, classification, error, runtimeConfig);
      logger.error("background.store_category_translation.batch_submit_failed", {
        runId: claimed.runId,
        batchId: claimed.id,
        provider: claimed.provider,
        model: claimed.model,
        failureCode: translationSubmissionFailureCode(error),
        classification,
        durationMs: Date.now() - startedAt,
      });
      if (classification === "AMBIGUOUS_CREATE") throw error;
      return { status: "skipped", batchId: claimed.id };
    }
  }

  private async claimReadyBatch(batchId: string): Promise<BatchToSubmit | null> {
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<BatchToSubmit[]>(Prisma.sql`
        UPDATE "commerce"."CommerceStoreCategoryTranslationBatch" b
        SET
          "status" = 'SUBMITTING',
          "submissionStartedAt" = NOW(),
          "lastSubmitAttemptAt" = NOW(),
          "submitAttemptCount" = "submitAttemptCount" + 1,
          "updatedAt" = NOW()
        FROM "commerce"."CommerceStoreCategoryTranslationRun" r
        WHERE b."id" = ${batchId}
          AND b."runId" = r."id"
          AND r."status" = 'PROCESSING'
          AND b."status" = 'READY'
          AND (b."nextSubmitAt" IS NULL OR b."nextSubmitAt" <= NOW())
        RETURNING b."id", b."runId", r."environment"::text AS "environment",
          b."provider", b."model", b."inputFileId", b."submitAttemptCount"
      `);
      return rows[0] ?? null;
    });
  }

  private async loadRequests(batchId: string): Promise<BatchItemRequest[]> {
    return this.database.$transaction(async (transaction) => transaction.$queryRaw<BatchItemRequest[]>(Prisma.sql`
      SELECT
        i."translationItemId" AS "translationId",
        i."providerCustomId",
        t."sourceLanguageTag",
        t."targetLanguageTag",
        t."sourceText"
      FROM "commerce"."CommerceStoreCategoryTranslationBatchItem" i
      INNER JOIN "commerce"."CommerceStoreCategoryTranslationItem" t
        ON t."id" = i."translationItemId"
      WHERE i."batchId" = ${batchId}
      ORDER BY i."createdAt", i."id"
    `));
  }

  private async persistInputFileId(batchId: string, inputFileId: string): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const affected = await transaction.$executeRaw(Prisma.sql`
        UPDATE "commerce"."CommerceStoreCategoryTranslationBatch"
        SET "inputFileId" = ${inputFileId}, "updatedAt" = NOW()
        WHERE "id" = ${batchId} AND "status" = 'SUBMITTING'
      `);
      if (affected !== 1) throw new Error("Store Category translation Batch input file write was stale");
    });
  }

  private async persistSubmitted(
    batchId: string,
    providerBatchId: string,
    inputFileId: string,
    runtimeConfig: BackgroundRuntimeConfigSnapshot,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const affected = await transaction.$executeRaw(Prisma.sql`
        UPDATE "commerce"."CommerceStoreCategoryTranslationBatch"
        SET
          "status" = 'SUBMITTED',
          "providerBatchId" = ${providerBatchId},
          "inputFileId" = ${inputFileId},
          "submittedAt" = NOW(),
          "pollSequence" = 1,
          "nextPollAt" = NOW() + (${runtimeConfig.translationInitialPollSeconds} * INTERVAL '1 second'),
          "failureCode" = NULL,
          "updatedAt" = NOW()
        WHERE "id" = ${batchId} AND "status" = 'SUBMITTING'
      `);
      if (affected !== 1) throw Object.assign(
        new Error("Accepted Store Category provider Batch could not be persisted"),
        { classification: "AMBIGUOUS_CREATE" as const },
      );
    });
  }

  private async persistFailure(
    batch: BatchToSubmit,
    classification: StoreCategorySubmitFailureClassification,
    error: unknown,
    runtimeConfig: BackgroundRuntimeConfigSnapshot,
  ): Promise<void> {
    const nextStatus = classification === "AMBIGUOUS_CREATE"
      ? "SUBMISSION_UNKNOWN"
      : classification === "DEFINITE_TERMINAL_NOT_CREATED" ||
          batch.submitAttemptCount >= runtimeConfig.translationSubmitMaxAttempts
        ? "FAILED"
        : "READY";
    const terminal = nextStatus === "FAILED";
    const nextSubmitAt = terminal || nextStatus !== "READY"
      ? null
      : new Date(Date.now() + runtimeConfig.translationSubmitRetrySeconds * 1000);
    const code = translationSubmissionFailureCode(error);

    await this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`
        UPDATE "commerce"."CommerceStoreCategoryTranslationBatch"
        SET
          "status" = CAST(${nextStatus} AS "commerce"."CommerceStoreCategoryTranslationBatchStatus"),
          "nextSubmitAt" = ${nextSubmitAt},
          "failureCode" = ${code},
          "completedAt" = CASE WHEN ${terminal} THEN NOW() ELSE "completedAt" END,
          "updatedAt" = NOW()
        WHERE "id" = ${batch.id} AND "status" = 'SUBMITTING'
      `);
      if (terminal) {
        await transaction.$executeRaw(Prisma.sql`
          UPDATE "commerce"."CommerceStoreCategoryTranslationItem"
          SET
            "status" = 'FAILED',
            "currentBatchId" = NULL,
            "failureCode" = ${code},
            "nextAttemptAt" = NULL,
            "updatedAt" = NOW()
          WHERE "currentBatchId" = ${batch.id} AND "status" = 'PENDING'
        `);
      }
    });
  }

  private async enqueuePoll(
    batchId: string,
    pollSequence: number,
    runtimeConfig: BackgroundRuntimeConfigSnapshot,
  ): Promise<void> {
    const job: StoreCategoryTranslationBatchPollJob = {
      schemaVersion: STORE_CATEGORY_TRANSLATION_SCHEMA_VERSION,
      translationBatchId: batchId,
      pollSequence,
    };
    try {
      await this.queue.add(
        STORE_CATEGORY_TRANSLATION_JOB_NAMES.BATCH_POLL,
        job,
        {
          jobId: createStoreCategoryTranslationBatchPollJobId(batchId, pollSequence),
          delay: runtimeConfig.translationInitialPollSeconds * 1000,
        },
      );
    } catch (error) {
      logger.warn("background.store_category_translation.poll_enqueue_failed", {
        batchId,
        pollSequence,
        errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
      });
    }
  }
}

export const storeCategoryTranslationBatchSubmitService =
  new StoreCategoryTranslationBatchSubmitService();
