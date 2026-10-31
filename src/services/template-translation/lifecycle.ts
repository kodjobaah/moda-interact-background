import { Queue } from "bullmq";
import { Prisma } from "@prisma/client";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { CommerceEnvironmentSchema } from "@modainteract/moda-interact-shared/commerce/model";

import prisma from "../../lib/db.js";
import { connectionRedis } from "../../lib/redis.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { readCanonicalCredentialKeyring } from "../../commerce/credential-keyring.js";
import { createTranslationProviderCredentialResolver, type TranslationProviderCredentialResolver } from "../../commerce/translation-provider-credential.js";
import { createOpenAITranslationProvider, type TranslationProvider, type TranslationRequest } from "../../providers/translation.provider.js";
import { backgroundRuntimeConfigService } from "../../runtime/background-runtime-config.js";
import { currentTranslationRuntimeConfig, type TranslationRuntimeConfigReader } from "../translation-runtime-config.js";
import { submitTranslationProviderBatch } from "../translation-batch-runtime/provider-submission.js";
import { pollTranslationProviderBatch } from "../translation-batch-runtime/provider-poll.js";
import { applyTranslationProviderResults } from "../translation-batch-runtime/provider-results.js";
import { translationSubmissionFailureCode } from "../translation-batch-runtime/failure-policy.js";
import { MERCHANT_COMMUNICATIONS_QUEUE_NAME } from "../../domain/translation-batch.js";
import {
  TEMPLATE_TRANSLATION_SCHEMA_VERSION, TEMPLATE_TRANSLATION_JOB_NAMES,
  templateTranslationPollJobId, templateTranslationResultsJobId,
} from "./jobs.js";
import { prepareTemplateTranslation, TemplateTranslationValidationError } from "./segment-codec.js";
import { TemplateTranslationRepository, type TemplateBatchRecord } from "./repository.js";

const logger = createLogger({
  serviceName: "moda-merchant-communications-worker",
  environment: resolveDeploymentEnvironmentName(),
});

type ProviderFactory = (options: { provider: string; model: string; apiKey: string }) => TranslationProvider;
type WorkQueue = Pick<Queue, "add">;

const boundedError = (error: unknown) => ({
  errorName: error instanceof Error ? error.name.slice(0, 96) : "unknown",
  errorCode: error instanceof TemplateTranslationValidationError
    ? error.code : translationSubmissionFailureCode(error),
});

export class TemplateTranslationBatchLifecycle {
  constructor(private readonly options: {
    repository?: TemplateTranslationRepository;
    queue?: WorkQueue;
    providerFactory?: ProviderFactory;
    credentialResolverFactory?: () => Promise<TranslationProviderCredentialResolver>;
    runtimeConfig?: TranslationRuntimeConfigReader;
  } = {}) {}

  private get repository() { return this.options.repository ?? new TemplateTranslationRepository(); }
  private defaultQueue: Queue | undefined;
  private get queue(): WorkQueue {
    return this.options.queue ?? (this.defaultQueue ??= new Queue(MERCHANT_COMMUNICATIONS_QUEUE_NAME, { connection: connectionRedis }));
  }
  private get config() { return currentTranslationRuntimeConfig(this.options.runtimeConfig ?? backgroundRuntimeConfigService); }

  async resolveProvider(batch: TemplateBatchRecord): Promise<TranslationProvider> {
    const environment = CommerceEnvironmentSchema.parse(batch.environment);
    const credentials = this.options.credentialResolverFactory
      ? await this.options.credentialResolverFactory()
      : createTranslationProviderCredentialResolver({ db: prisma, keyring: await readCanonicalCredentialKeyring() });
    const apiKey = await credentials.resolve({ environment, provider: batch.provider });
    return (this.options.providerFactory ?? createOpenAITranslationProvider)({
      provider: batch.provider, model: batch.providerModelId, apiKey,
    });
  }

  async submit(batchId: string): Promise<"submitted" | "skipped" | "retrying"> {
    const batch = await this.repository.claimReadyBatch(batchId);
    if (!batch) return "skipped";
    const config = this.config;
    try {
      const snapshot = this.repository.assertRunSnapshot(batch);
      const prepared = prepareTemplateTranslation(snapshot);
      const members = await this.repository.members(batchId);
      if (!members.length || members.some((member) => member.status !== "PENDING" || member.currentBatchId !== batchId)) {
        throw new TemplateTranslationValidationError("BATCH_MEMBERSHIP_STALE");
      }
      let provider: TranslationProvider;
      try { provider = await this.resolveProvider(batch); }
      catch (error) {
        await this.repository.markBatchTerminal(batch, "PROVIDER_CONFIGURATION_UNAVAILABLE", { maxRetries: 0, retrySeconds: 0 });
        throw error;
      }
      const submission = await submitTranslationProviderBatch({
        logicalBatchId: batchId,
        inputFileId: batch.inputFileId,
        provider,
        loadRequests: async () => members.map((member): TranslationRequest => ({
          translationId: member.translationItemId,
          providerCustomId: member.providerCustomId,
          sourceLanguageTag: snapshot.sourceLanguageTag,
          targetLanguageTag: member.targetLanguageTag,
          translationFormat: "keyed-segments-v1",
          sourceText: prepared.requestText,
        })),
        persistInputFileId: (id) => this.repository.persistInputFileId(batchId, id),
        persistSubmitted: ({ providerBatchId, inputFileId }) =>
          this.repository.persistSubmitted(batchId, providerBatchId, inputFileId, config.translationInitialPollSeconds),
      });
      if (submission.kind === "failed") {
        logger.error("background.template_translation.batch_submission_failed", {
          runId: batch.id, batchId, classification: submission.classification,
          phase: submission.phase, error: submission.error, ...boundedError(submission.error),
          errorMessage: submission.error instanceof Error ? submission.error.message : String(submission.error),
        });
        if (submission.classification === "AMBIGUOUS_CREATE") {
          await this.recordSubmissionUnknown(batchId);
          throw submission.error;
        }
        if (submission.classification === "DEFINITE_TERMINAL_NOT_CREATED") {
          await this.repository.markBatchTerminal(batch, "PROVIDER_SUBMISSION_REJECTED", {
            maxRetries: 0, retrySeconds: config.translationResultRetrySeconds,
          });
          return "skipped";
        }
        await this.rescheduleSubmission(batchId, batch.submitAttemptCount, config.translationSubmitMaxAttempts);
        return "retrying";
      }
      await this.queue.add(TEMPLATE_TRANSLATION_JOB_NAMES.POLL, {
        schemaVersion: TEMPLATE_TRANSLATION_SCHEMA_VERSION, translationBatchId: batchId, pollSequence: 1,
      }, { jobId: templateTranslationPollJobId(batchId, 1), delay: config.translationInitialPollSeconds * 1000 });
      logger.info("background.template_translation.batch_submitted", { runId: batch.id, batchId });
      return "submitted";
    } catch (error) {
      if (error instanceof TemplateTranslationValidationError || error instanceof Error && error.message === "STALE_TEMPLATE_DEFINITION_HASH") {
        await this.repository.markBatchTerminal(batch, "INVALID_TEMPLATE_BATCH_SOURCE", { maxRetries: 0, retrySeconds: 0 });
      }
      logger.error("background.template_translation.submit_exception", { runId: batch.id, batchId, error, ...boundedError(error),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      // Explicit transient/unknown provider failures must bubble to BullMQ. Reconciliation
      // will correlate the unknown provider Batch rather than submitting a duplicate.
      throw error;
    }
  }

  private async rescheduleSubmission(batchId: string, attempts: number, maxAttempts: number): Promise<void> {
    if (attempts >= maxAttempts) {
      const batch = await this.repository.loadBatch(batchId);
      if (!batch) throw new Error("TEMPLATE_BATCH_MISSING_ON_RETRY");
      await this.repository.markBatchTerminal(batch, "PROVIDER_SUBMISSION_EXHAUSTED", { maxRetries: 0, retrySeconds: 0 });
      return;
    }
    const affected = await this.repository.db.$executeRaw(Prisma.sql`
      UPDATE "whatsapp"."WhatsAppTemplateTranslationBatch"
      SET "status" = 'READY',
        "nextSubmitAt" = ${new Date(Date.now() + this.config.translationSubmitRetrySeconds * 1000)},
        "failureCode" = 'SUBMISSION_RETRYABLE', "updatedAt" = NOW()
      WHERE "id" = ${batchId} AND "status" = 'SUBMITTING'
    `);
    if (affected !== 1) throw new Error("STALE_TEMPLATE_SUBMISSION_RETRY");

  }

  private async recordSubmissionUnknown(batchId: string): Promise<void> {
    await this.repository.db.$executeRaw(Prisma.sql`
      UPDATE "whatsapp"."WhatsAppTemplateTranslationBatch"
      SET "status" = 'SUBMISSION_UNKNOWN', "failureCode" = 'AMBIGUOUS_CREATE', "updatedAt" = NOW()
      WHERE "id" = ${batchId} AND "status" = 'SUBMITTING'
    `);
  }

  async poll(batchId: string, sequence: number): Promise<"skipped" | "rescheduled" | "completed" | "terminal"> {
    const batch = await this.repository.loadBatch(batchId);
    if (!batch || batch.batchStatus !== "SUBMITTED" || batch.pollSequence !== sequence || !batch.providerBatchId) return "skipped";
    const config = this.config;
    const schedule = async (failed: boolean) => {
      if ((batch.submittedAt && Date.now() - batch.submittedAt.getTime() >= 26 * 60 * 60_000) || sequence >= 2000) {
        await this.repository.markBatchTerminal(batch, "PROVIDER_POLL_EXHAUSTED", {
          maxRetries: config.translationMaxAutoRetries, retrySeconds: config.translationResultRetrySeconds,
        });
        return "terminal" as const;
      }
      const changed = await this.repository.db.$executeRaw(Prisma.sql`
        UPDATE "whatsapp"."WhatsAppTemplateTranslationBatch"
        SET "pollSequence" = ${sequence + 1}, "lastPolledAt" = NOW(),
          "nextPollAt" = NOW() + (${config.translationPollIntervalSeconds} * INTERVAL '1 second'),
          "updatedAt" = NOW()
        WHERE "id" = ${batchId} AND "status" = 'SUBMITTED' AND "pollSequence" = ${sequence}
      `);
      if (!changed) return "skipped" as const;
      await this.queue.add(TEMPLATE_TRANSLATION_JOB_NAMES.POLL, {
        schemaVersion: TEMPLATE_TRANSLATION_SCHEMA_VERSION,
        translationBatchId: batchId, pollSequence: sequence + 1,
      }, {
        jobId: templateTranslationPollJobId(batchId, sequence + 1),
        delay: config.translationPollIntervalSeconds * 1000,
      });
      if (failed) logger.warn("background.template_translation.provider_poll_retry", { runId: batch.id, batchId, sequence });
      return "rescheduled" as const;
    };
    try {
      return await pollTranslationProviderBatch({
        retrieve: async () => (await this.resolveProvider(batch)).retrieveBatch(batch.providerBatchId!),
        onReadFailure: async (error) => {
          logger.error("background.template_translation.provider_poll_exception", { runId: batch.id, batchId, error, ...boundedError(error),
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          return schedule(true);
        },
        onNonterminal: async () => schedule(false),
        onCompleted: async (providerBatch): Promise<"skipped" | "completed" | "terminal"> => {
          if (!providerBatch.outputFileId && !providerBatch.errorFileId) {
            logger.error("background.template_translation.provider_missing_results", { runId: batch.id, batchId });
            await this.repository.markBatchTerminal(batch, "PROVIDER_RESULT_FILES_MISSING", { maxRetries: 0, retrySeconds: 0 });
            return "terminal";
          }
          const changed = await this.repository.db.$executeRaw(Prisma.sql`
            UPDATE "whatsapp"."WhatsAppTemplateTranslationBatch"
            SET "status" = 'PROVIDER_COMPLETED', "outputFileId" = ${providerBatch.outputFileId},
              "errorFileId" = ${providerBatch.errorFileId}, "lastPolledAt" = NOW(),
              "nextPollAt" = NULL, "updatedAt" = NOW()
            WHERE "id" = ${batchId} AND "status" = 'SUBMITTED' AND "pollSequence" = ${sequence}
          `);
          if (!changed) return "skipped";
          await this.queue.add(TEMPLATE_TRANSLATION_JOB_NAMES.RESULTS, {
            schemaVersion: TEMPLATE_TRANSLATION_SCHEMA_VERSION, translationBatchId: batchId,
          }, { jobId: templateTranslationResultsJobId(batchId) });
          return "completed";
        },
        onTerminal: async (providerBatch): Promise<"terminal"> => {
          logger.warn("background.template_translation.provider_terminal", {
            runId: batch.id, batchId, providerStatus: providerBatch.status,
            failureCode: providerBatch.failureCode,
          });
          await this.repository.markBatchTerminal(batch, providerBatch.failureCode ?? "PROVIDER_TERMINAL", {
            maxRetries: config.translationMaxAutoRetries, retrySeconds: config.translationResultRetrySeconds,
          });
          return "terminal";
        },
      });
    } catch (error) {
      logger.error("background.template_translation.poll_exception", { runId: batch.id, batchId, error, ...boundedError(error),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.defaultQueue?.close();
  }

  async ingest(batchId: string): Promise<"skipped" | "completed"> {
    const batch = await this.repository.loadBatch(batchId);
    if (!batch || batch.batchStatus !== "PROVIDER_COMPLETED" || batch.status !== "PROCESSING") return "skipped";
    const config = this.config;
    try {
      const snapshot = this.repository.assertRunSnapshot(batch);
      const prepared = prepareTemplateTranslation(snapshot);
      const provider = await this.resolveProvider(batch);
      const members = await this.repository.members(batchId);
      await applyTranslationProviderResults({
        provider, outputFileId: batch.outputFileId, errorFileId: batch.errorFileId,
        missingResultFileMessage: "TEMPLATE_RESULT_FILE_UNAVAILABLE",
        loadExpectedProviderCustomIds: async () => members.map((item) => item.providerCustomId),
        membershipMessages: {
          countMismatch: "TEMPLATE_RESULT_COUNT_MISMATCH",
          unknownProviderCustomId: () => "TEMPLATE_UNKNOWN_PROVIDER_CUSTOM_ID",
          duplicateProviderCustomId: "TEMPLATE_DUPLICATE_PROVIDER_RESULT",
        },
        applyResult: async (result) => {
          if (result.status !== "completed" || !result.translatedText) {
            return this.repository.setResult({
              batchId, providerCustomId: result.providerCustomId,
              translated: null, failureCode: result.failureCode ?? "PROVIDER_RESULT_FAILED",
              maxRetries: config.translationMaxAutoRetries, retrySeconds: config.translationResultRetrySeconds,
            });
          }
          try {
            const translated = prepared.restore(result.translatedText);
            return await this.repository.setResult({
              batchId, providerCustomId: result.providerCustomId,
              translated, failureCode: null, maxRetries: 0, retrySeconds: 0,
            });
          } catch (error) {
            if (!(error instanceof TemplateTranslationValidationError)) throw error;
            logger.warn("background.template_translation.item_validation_failed", {
              runId: batch.id, batchId, error, ...boundedError(error),
              errorMessage: error instanceof Error ? error.message : String(error),
            });
            return this.repository.setResult({
              batchId, providerCustomId: result.providerCustomId, translated: null,
              failureCode: error.code, maxRetries: 0, retrySeconds: 0,
            });
          }
        },
      });
      await this.repository.finishBatch(batchId, batch.id);
      logger.info("background.template_translation.batch_completed", { runId: batch.id, batchId });
      return "completed";
    } catch (error) {
      if (error instanceof TemplateTranslationValidationError || error instanceof Error && error.message === "STALE_TEMPLATE_DEFINITION_HASH") {
        await this.repository.failRunInput(batch.id, "INVALID_OR_STALE_SOURCE_SNAPSHOT");
        await this.repository.markBatchTerminal(batch, "INVALID_TEMPLATE_BATCH_SOURCE", { maxRetries: 0, retrySeconds: 0 });
      }
      if (batch.submittedAt && Date.now() - batch.submittedAt.getTime() > 48 * 60 * 60_000) {
        await this.repository.markBatchTerminal(batch, "PROVIDER_RESULTS_UNRESOLVED", { maxRetries: 0, retrySeconds: 0 });
      }
      logger.error("background.template_translation.results_exception", { runId: batch.id, batchId, error, ...boundedError(error),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
