import { Queue } from "bullmq";
import { Prisma } from "@prisma/client";
import { CommerceEnvironmentSchema, type CommerceEnvironment } from "@modainteract/moda-interact-shared/commerce/model";
import { createLogger } from "@modainteract/moda-interact-shared/logging";

import {
  MERCHANT_PRICING_TRANSLATION_JOB_NAMES,
  MERCHANT_PRICING_TRANSLATION_SCHEMA_VERSION,
  createMerchantPricingTranslationBatchPollJobId,
  createMerchantPricingTranslationBatchResultsJobId,
  type MerchantPricingTranslationBatchPollJob,
  type MerchantPricingTranslationBatchResultsJob,
} from "../domain/merchant-pricing-translation.js";
import { MERCHANT_COMMUNICATIONS_QUEUE_NAME } from "../domain/translation-batch.js";
import {
  createOpenAITranslationProvider,
  type TranslationProvider,
  type TranslationProviderBatch,
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
import { isTranslationProviderFailureRetryable } from "./translation-batch-runtime/failure-policy.js";
import {
  pollTranslationProviderBatch,
  translationTerminalItemDisposition,
} from "./translation-batch-runtime/provider-poll.js";

type PollBatch = {
  id: string;
  runId: string;
  environment: string;
  provider: string;
  model: string;
  providerBatchId: string | null;
  status: string;
  pollSequence: number;
};

type PollTransaction = {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
};

type PollDatabase = {
  $transaction<T>(callback: (transaction: PollTransaction) => Promise<T>): Promise<T>;
};

type PollQueue = Pick<Queue, "add">;
type ProviderFactory = (options: { provider: string; model: string; apiKey: string }) => TranslationProvider;

const logger = createLogger({
  serviceName: "moda-merchant-communications-worker",
  environment: resolveDeploymentEnvironmentName(),
});

function providerResponseSummary(batch: TranslationProviderBatch) {
  return {
    status: batch.providerStatus,
    normalizedStatus: batch.status,
    createdAt: batch.createdAt,
    inProgressAt: batch.inProgressAt ?? null,
    expiresAt: batch.expiresAt ?? null,
    finalizingAt: batch.finalizingAt ?? null,
    completedAt: batch.completedAt,
    failedAt: batch.failedAt ?? null,
    expiredAt: batch.expiredAt ?? null,
    cancellingAt: batch.cancellingAt ?? null,
    cancelledAt: batch.cancelledAt ?? null,
    requestCounts: batch.requestCounts ?? null,
    outputFileAvailable: Boolean(batch.outputFileId),
    errorFileAvailable: Boolean(batch.errorFileId),
    failureCode: batch.failureCode,
  };
}

function defaultCredentialResolver(): TranslationProviderCredentialResolver {
  return createTranslationProviderCredentialResolver({
    db: prisma,
    keyring: readCommerceCredentialKeyring(),
  });
}

export type MerchantPricingTranslationBatchPollResult =
  | { status: "stale"; batchId: string }
  | { status: "rescheduled"; batchId: string; pollSequence: number }
  | { status: "completed"; batchId: string }
  | { status: "terminal"; batchId: string; providerStatus: string };

export class MerchantPricingTranslationBatchPollService {
  private readonly database: PollDatabase;
  private readonly providerFactory: ProviderFactory;
  private readonly queue: PollQueue;
  private readonly runtimeConfig: TranslationRuntimeConfigReader;
  private readonly credentialResolverFactory: () => TranslationProviderCredentialResolver;

  constructor(options: {
    database?: PollDatabase;
    providerFactory?: ProviderFactory;
    queue?: PollQueue;
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

  async poll(input: MerchantPricingTranslationBatchPollJob): Promise<MerchantPricingTranslationBatchPollResult> {
    const batch = await this.loadBatch(input.translationBatchId);
    if (
      !batch ||
      batch.status !== "SUBMITTED" ||
      batch.pollSequence !== input.pollSequence ||
      !batch.providerBatchId
    ) {
      return { status: "stale", batchId: input.translationBatchId };
    }
    const providerBatchId = batch.providerBatchId;
    const runtimeConfig = currentTranslationRuntimeConfig(this.runtimeConfig);

    return pollTranslationProviderBatch({
      retrieve: async () => {
        const environment = CommerceEnvironmentSchema.parse(batch.environment) as CommerceEnvironment;
        const apiKey = await this.credentialResolverFactory().resolve({
          environment,
          provider: batch.provider,
        });
        const provider = this.providerFactory({
          provider: batch.provider,
          model: batch.model,
          apiKey,
        });
        return provider.retrieveBatch(providerBatchId);
      },
      onReadFailure: async (error) => {
        const schedule = await this.rescheduleAfterReadFailure(batch, runtimeConfig);
        await this.enqueuePoll(
          batch.id,
          schedule.pollSequence,
          runtimeConfig.translationPollIntervalSeconds,
        );
        logger.warn("background.merchant_pricing_translation.batch_poll_failed", {
          runId: batch.runId,
          batchId: batch.id,
          pollSequence: schedule.pollSequence,
          nextPollAt: schedule.nextPollAt?.toISOString() ?? null,
          errorName: error instanceof Error ? error.name.slice(0, 128) : "unknown",
        });
        return { status: "rescheduled", batchId: batch.id, pollSequence: schedule.pollSequence };
      },
      onNonterminal: async (providerBatch) => {
        const schedule = await this.advanceNonterminal(batch, runtimeConfig);
        await this.enqueuePoll(
          batch.id,
          schedule.pollSequence,
          runtimeConfig.translationPollIntervalSeconds,
        );
        logger.info("background.merchant_pricing_translation.batch_polled", {
          runId: batch.runId,
          batchId: batch.id,
          providerBatchId: batch.providerBatchId,
          provider: batch.provider,
          model: batch.model,
          providerStatus: providerBatch.providerStatus,
          normalizedStatus: providerBatch.status,
          providerResponse: providerResponseSummary(providerBatch),
          pollSequence: batch.pollSequence,
          nextPollSequence: schedule.pollSequence,
          nextPollAt: schedule.nextPollAt?.toISOString() ?? null,
          pollIntervalSeconds: runtimeConfig.translationPollIntervalSeconds,
        });
        return {
          status: "rescheduled",
          batchId: batch.id,
          pollSequence: schedule.pollSequence,
        };
      },
      onCompleted: async (providerBatch) => {
        const updated = await this.database.$transaction(async (transaction) =>
          transaction.$executeRaw(Prisma.sql`
            UPDATE "billing"."MerchantPricingTranslationBatch"
            SET
              "status" = 'PROVIDER_COMPLETED',
              "outputFileId" = ${providerBatch.outputFileId},
              "errorFileId" = ${providerBatch.errorFileId},
              "lastPolledAt" = NOW(),
              "nextPollAt" = NULL,
              "failureCode" = NULL,
              "updatedAt" = NOW()
            WHERE "id" = ${batch.id}
              AND "status" = 'SUBMITTED'
              AND "pollSequence" = ${batch.pollSequence}
          `));
        if (updated !== 1) return { status: "stale", batchId: batch.id } as const;
        logger.info("background.merchant_pricing_translation.batch_polled", {
          runId: batch.runId,
          batchId: batch.id,
          providerBatchId: batch.providerBatchId,
          provider: batch.provider,
          model: batch.model,
          providerStatus: providerBatch.providerStatus,
          normalizedStatus: providerBatch.status,
          providerResponse: providerResponseSummary(providerBatch),
          pollSequence: batch.pollSequence,
          outputFileAvailable: Boolean(providerBatch.outputFileId),
          errorFileAvailable: Boolean(providerBatch.errorFileId),
        });
        await this.enqueueResults(batch.id);
        return { status: "completed", batchId: batch.id } as const;
      },
      onTerminal: async (providerBatch) => {
        const terminalApplied = await this.persistTerminalBatch(
          batch,
          providerBatch.status,
          providerBatch.failureCode,
          runtimeConfig,
        );
        if (!terminalApplied) return { status: "stale", batchId: batch.id } as const;
        logger.warn("background.merchant_pricing_translation.batch_polled", {
          runId: batch.runId,
          batchId: batch.id,
          providerBatchId: batch.providerBatchId,
          provider: batch.provider,
          model: batch.model,
          providerStatus: providerBatch.providerStatus,
          normalizedStatus: providerBatch.status,
          providerResponse: providerResponseSummary(providerBatch),
          pollSequence: batch.pollSequence,
        });
        return {
          status: "terminal",
          batchId: batch.id,
          providerStatus: providerBatch.status,
        } as const;
      },
    });
  }

  private async loadBatch(batchId: string): Promise<PollBatch | null> {
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<PollBatch[]>(Prisma.sql`
        SELECT b."id", b."runId", r."environment"::text AS "environment",
          b."provider", b."model", b."providerBatchId", b."status"::text AS "status", b."pollSequence"
        FROM "billing"."MerchantPricingTranslationBatch" b
        INNER JOIN "billing"."MerchantPricingTranslationRun" r ON r."id" = b."runId"
        WHERE b."id" = ${batchId} AND r."status" = 'PROCESSING'
      `);
      return rows[0] ?? null;
    });
  }

  private async rescheduleAfterReadFailure(
    batch: PollBatch,
    runtimeConfig: BackgroundRuntimeConfigSnapshot,
  ): Promise<{ pollSequence: number; nextPollAt: Date | null }> {
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ pollSequence: number; nextPollAt: Date | null }>>(Prisma.sql`
        UPDATE "billing"."MerchantPricingTranslationBatch"
        SET
          "lastPolledAt" = NOW(),
          "nextPollAt" = NOW() + (${runtimeConfig.translationPollIntervalSeconds} * INTERVAL '1 second'),
          "pollSequence" = "pollSequence" + 1,
          "failureCode" = 'poll-read-failed',
          "updatedAt" = NOW()
        WHERE "id" = ${batch.id}
          AND "status" = 'SUBMITTED'
          AND "pollSequence" = ${batch.pollSequence}
        RETURNING "pollSequence", "nextPollAt"
      `);
      return rows[0] ?? { pollSequence: batch.pollSequence, nextPollAt: null };
    });
  }

  private async advanceNonterminal(
    batch: PollBatch,
    runtimeConfig: BackgroundRuntimeConfigSnapshot,
  ): Promise<{ pollSequence: number; nextPollAt: Date | null }> {
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ pollSequence: number; nextPollAt: Date | null }>>(Prisma.sql`
        UPDATE "billing"."MerchantPricingTranslationBatch"
        SET
          "lastPolledAt" = NOW(),
          "nextPollAt" = NOW() + (${runtimeConfig.translationPollIntervalSeconds} * INTERVAL '1 second'),
          "pollSequence" = "pollSequence" + 1,
          "failureCode" = NULL,
          "updatedAt" = NOW()
        WHERE "id" = ${batch.id}
          AND "status" = 'SUBMITTED'
          AND "pollSequence" = ${batch.pollSequence}
        RETURNING "pollSequence", "nextPollAt"
      `);
      return rows[0] ?? { pollSequence: batch.pollSequence, nextPollAt: null };
    });
  }

  private async persistTerminalBatch(
    batch: PollBatch,
    providerStatus: string,
    failureCode: string | null,
    runtimeConfig: BackgroundRuntimeConfigSnapshot,
  ): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const claimed = await transaction.$executeRaw(Prisma.sql`
        UPDATE "billing"."MerchantPricingTranslationBatch"
        SET
          "status" = CAST(${providerStatus.toUpperCase()} AS "billing"."MerchantPricingTranslationBatchStatus"),
          "lastPolledAt" = NOW(),
          "nextPollAt" = NULL,
          "failureCode" = ${failureCode ?? providerStatus},
          "completedAt" = NOW(),
          "updatedAt" = NOW()
        WHERE "id" = ${batch.id}
          AND "status" = 'SUBMITTED'
          AND "pollSequence" = ${batch.pollSequence}
      `);
      if (claimed !== 1) return false;

      const items = await transaction.$queryRaw<Array<{ translationItemId: string; retryCount: number }>>(Prisma.sql`
        SELECT i."translationItemId", t."retryCount"
        FROM "billing"."MerchantPricingTranslationBatchItem" i
        INNER JOIN "billing"."MerchantPricingTranslationItem" t ON t."id" = i."translationItemId"
        WHERE i."batchId" = ${batch.id}
      `);
      for (const item of items) {
        const disposition = translationTerminalItemDisposition({
          failureCode,
          retryCount: item.retryCount,
          maxAutoRetries: runtimeConfig.translationMaxAutoRetries,
          retryDelaySeconds: runtimeConfig.translationResultRetrySeconds,
        });
        await transaction.$executeRaw(Prisma.sql`
          UPDATE "billing"."MerchantPricingTranslationItem"
          SET
            "status" = CAST(${disposition.status} AS "billing"."MerchantPricingTranslationItemStatus"),
            "currentBatchId" = NULL,
            "retryCount" = "retryCount" + ${disposition.retryIncrement},
            "nextAttemptAt" = ${disposition.nextAttemptAt},
            "failureCode" = ${failureCode ?? providerStatus},
            "updatedAt" = NOW()
          WHERE "id" = ${item.translationItemId}
            AND "status" = 'PENDING'
            AND "currentBatchId" = ${batch.id}
        `);
      }
      return true;
    });
  }

  private async enqueuePoll(batchId: string, pollSequence: number, delaySeconds: number): Promise<void> {
    const job: MerchantPricingTranslationBatchPollJob = {
      schemaVersion: MERCHANT_PRICING_TRANSLATION_SCHEMA_VERSION,
      translationBatchId: batchId,
      pollSequence,
    };
    try {
      await this.queue.add(MERCHANT_PRICING_TRANSLATION_JOB_NAMES.BATCH_POLL, job, {
        jobId: createMerchantPricingTranslationBatchPollJobId(batchId, pollSequence),
        delay: delaySeconds * 1000,
      });
    } catch (error) {
      logger.warn("background.merchant_pricing_translation.poll_enqueue_failed", {
        batchId,
        pollSequence,
        errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
      });
    }
  }

  private async enqueueResults(batchId: string): Promise<void> {
    const job: MerchantPricingTranslationBatchResultsJob = {
      schemaVersion: MERCHANT_PRICING_TRANSLATION_SCHEMA_VERSION,
      translationBatchId: batchId,
    };
    try {
      await this.queue.add(MERCHANT_PRICING_TRANSLATION_JOB_NAMES.BATCH_RESULTS, job, {
        jobId: createMerchantPricingTranslationBatchResultsJobId(batchId),
      });
    } catch (error) {
      logger.warn("background.merchant_pricing_translation.results_enqueue_failed", {
        batchId,
        errorMessage: error instanceof Error ? error.message.slice(0, 256) : "unknown failure",
      });
    }
  }
}

export const merchantPricingTranslationBatchPollService =
  new MerchantPricingTranslationBatchPollService();

export const merchantPricingTranslationPollTestInternals = {
  failureIsRetryable: isTranslationProviderFailureRetryable,
};
