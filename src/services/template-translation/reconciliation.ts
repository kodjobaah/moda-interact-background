import { Queue } from "bullmq";
import { Prisma } from "@prisma/client";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { MERCHANT_COMMUNICATIONS_QUEUE_NAME } from "../../domain/translation-batch.js";
import { connectionRedis } from "../../lib/redis.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { backgroundRuntimeConfigService } from "../../runtime/background-runtime-config.js";
import { currentTranslationRuntimeConfig, type TranslationRuntimeConfigReader } from "../translation-runtime-config.js";
import { ensureDeterministicTranslationQueueJob } from "../translation-batch-runtime/queue-job-repair.js";
import { routeTranslationBatchCorrelation } from "../translation-batch-runtime/provider-correlation.js";
import { TemplateTranslationRepository } from "./repository.js";
import { TemplateTranslationValidationError } from "./segment-codec.js";
import { TemplateTranslationBatchLifecycle } from "./lifecycle.js";
import {
  TEMPLATE_TRANSLATION_SCHEMA_VERSION, TEMPLATE_TRANSLATION_JOB_NAMES,
  templateTranslationSubmitJobId, templateTranslationPollJobId, templateTranslationResultsJobId,
} from "./jobs.js";

const logger = createLogger({
  serviceName: "moda-merchant-communications-worker",
  environment: resolveDeploymentEnvironmentName(),
});

type QueuePort = Pick<Queue, "add" | "getJob"> & { close?: () => Promise<void> };
export type TranslationRunOutcome =
  | { status: "not-found" | "unchanged"; runId: string }
  | { status: "scheduled"; runId: string; batchId: string; itemCount: number };

/** PostgreSQL is the authority; BullMQ is a repairable delivery mechanism. */
export class TemplateTranslationCoordinator {
  private readonly repository: TemplateTranslationRepository;
  private readonly lifecycle: TemplateTranslationBatchLifecycle;
  private readonly queue: QueuePort;
  private readonly runtimeConfig: TranslationRuntimeConfigReader;

  constructor(options: {
    repository?: TemplateTranslationRepository;
    lifecycle?: TemplateTranslationBatchLifecycle;
    queue?: QueuePort;
    runtimeConfig?: TranslationRuntimeConfigReader;
  } = {}) {
    this.repository = options.repository ?? new TemplateTranslationRepository();
    this.queue = options.queue ?? new Queue(MERCHANT_COMMUNICATIONS_QUEUE_NAME, { connection: connectionRedis });
    this.runtimeConfig = options.runtimeConfig ?? backgroundRuntimeConfigService;
    this.lifecycle = options.lifecycle ?? new TemplateTranslationBatchLifecycle({
      repository: this.repository, queue: this.queue, runtimeConfig: this.runtimeConfig,
    });
  }

  async executeTemplateTranslation(runId: string): Promise<TranslationRunOutcome> {
    const run = await this.repository.loadRun(runId);
    if (!run) return { status: "not-found", runId };
    if (!["PENDING", "PROCESSING"].includes(run.status)) return { status: "unchanged", runId };
    try {
      this.repository.assertRunSnapshot(run);
      const batch = await this.repository.assemble(
        runId, currentTranslationRuntimeConfig(this.runtimeConfig).translationBatchMaxRequests,
      );
      if (!batch) return { status: "unchanged", runId };
      await this.ensureBatchJob(batch.batchId, "READY", 0);
      logger.info("background.template_translation.run_scheduled", { runId, batchId: batch.batchId, itemCount: batch.itemCount });
      return { status: "scheduled", runId, batchId: batch.batchId, itemCount: batch.itemCount };
    } catch (error) {
      if (error instanceof TemplateTranslationValidationError || error instanceof Error && error.message === "STALE_TEMPLATE_DEFINITION_HASH") {
        await this.repository.failRunInput(runId, "INVALID_OR_STALE_SOURCE_SNAPSHOT");
      }
      logger.error("background.template_translation.execute_exception", {
        runId, error, errorName: error instanceof Error ? error.name.slice(0, 128) : "unknown",
        errorCode: error instanceof Error ? error.name === "TemplateTranslationValidationError" ? "INVALID_SNAPSHOT" : "EXECUTION_FAILED" : "EXECUTION_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async reconcile(limit = currentTranslationRuntimeConfig(this.runtimeConfig).translationReconciliationPageSize): Promise<{ processedRuns: number; jobsRepaired: number; ambiguous: number }> {
    const pageSize = Math.max(1, Math.min(500, limit));
    let processedRuns = 0, jobsRepaired = 0, ambiguous = 0;
    try {
      const runRows = await this.repository.db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT r."id" FROM "whatsapp"."WhatsAppTemplateTranslationRun" r
        WHERE (r."status" = 'PENDING' OR r."status" = 'PROCESSING' AND EXISTS (
            SELECT 1 FROM "whatsapp"."WhatsAppTemplateTranslationItem" i
            WHERE i."runId" = r."id" AND i."status" = 'PENDING'
              AND i."currentBatchId" IS NULL AND (i."nextAttemptAt" IS NULL OR i."nextAttemptAt" <= NOW())
          ))
        ORDER BY r."requestedAt", r."id" LIMIT ${pageSize}
      `);
      for (const row of runRows) {
        const outcome = await this.executeTemplateTranslation(row.id);
        if (outcome.status === "scheduled") processedRuns++;
      }
      const batchRows = await this.repository.db.$queryRaw<Array<{ id: string; status: string; pollSequence: number }>>(Prisma.sql`
        SELECT b."id", b."status", b."pollSequence"
        FROM "whatsapp"."WhatsAppTemplateTranslationBatch" b
        JOIN "whatsapp"."WhatsAppTemplateTranslationRun" r ON r."id" = b."runId"
        WHERE r."status" = 'PROCESSING' AND (
          (b."status" = 'READY' AND (b."nextSubmitAt" IS NULL OR b."nextSubmitAt" <= NOW())) OR
          (b."status" = 'SUBMITTED' AND (b."nextPollAt" IS NULL OR b."nextPollAt" <= NOW())) OR
          b."status" IN ('PROVIDER_COMPLETED', 'SUBMISSION_UNKNOWN') OR
          (b."status" = 'SUBMITTING' AND b."submissionStartedAt" < NOW() - INTERVAL '5 minutes')
        )
        ORDER BY b."createdAt", b."id" LIMIT ${pageSize}
      `);
      for (const row of batchRows) {
        if (row.status === "SUBMISSION_UNKNOWN" || row.status === "SUBMITTING") {
          const result = await this.reconcileUnknown(row.id);
          if (result === "ambiguous") ambiguous++;
          if (result !== "recovered") continue;
        }
        const batch = await this.repository.loadBatch(row.id);
        if (!batch) continue;
        jobsRepaired += await this.ensureBatchJob(row.id, batch.batchStatus, batch.pollSequence);
      }
      const terminalCandidates = await this.repository.db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT r."id" FROM "whatsapp"."WhatsAppTemplateTranslationRun" r
        WHERE r."status" = 'PROCESSING' AND (
          NOT EXISTS (SELECT 1 FROM "whatsapp"."WhatsAppTemplateTranslationItem" i WHERE i."runId" = r."id")
          OR EXISTS (SELECT 1 FROM "whatsapp"."WhatsAppTemplateTranslationItem" i WHERE i."runId" = r."id" AND i."status" = 'FAILED')
          OR NOT EXISTS (SELECT 1 FROM "whatsapp"."WhatsAppTemplateTranslationItem" i WHERE i."runId" = r."id" AND i."status" <> 'AVAILABLE')
        ) ORDER BY r."requestedAt", r."id" LIMIT ${pageSize}
      `);
      for (const row of terminalCandidates) await this.repository.advanceRunState(row.id);
      return { processedRuns, jobsRepaired, ambiguous };
    } catch (error) {
      logger.error("background.template_translation.reconcile_exception", {
        error, errorName: error instanceof Error ? error.name.slice(0, 128) : "unknown",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async ensureBatchJob(batchId: string, state: string, sequence: number): Promise<number> {
    if (state === "READY") {
      return ensureDeterministicTranslationQueueJob(this.queue, {
        id: templateTranslationSubmitJobId(batchId),
        name: TEMPLATE_TRANSLATION_JOB_NAMES.SUBMIT,
        data: { schemaVersion: TEMPLATE_TRANSLATION_SCHEMA_VERSION, translationBatchId: batchId },
      });
    }
    if (state === "SUBMITTED") {
      return ensureDeterministicTranslationQueueJob(this.queue, {
        id: templateTranslationPollJobId(batchId, sequence),
        name: TEMPLATE_TRANSLATION_JOB_NAMES.POLL,
        data: { schemaVersion: TEMPLATE_TRANSLATION_SCHEMA_VERSION, translationBatchId: batchId, pollSequence: sequence },
      });
    }
    if (state === "PROVIDER_COMPLETED") {
      return ensureDeterministicTranslationQueueJob(this.queue, {
        id: templateTranslationResultsJobId(batchId),
        name: TEMPLATE_TRANSLATION_JOB_NAMES.RESULTS,
        data: { schemaVersion: TEMPLATE_TRANSLATION_SCHEMA_VERSION, translationBatchId: batchId },
      });
    }
    return 0;
  }

  private async reconcileUnknown(batchId: string): Promise<"recovered" | "ambiguous"> {
    const batch = await this.repository.loadBatch(batchId);
    if (!batch || !["SUBMISSION_UNKNOWN", "SUBMITTING"].includes(batch.batchStatus)) return "ambiguous";
    // A SUBMITTING request older than five minutes might have created a provider
    // Batch. Never blindly re-create it; use the existing ARCH-031 correlation.
    const ageMs = Date.now() - (batch.submissionStartedAt?.getTime() ?? 0);
    try {
      const provider = await this.lifecycle.resolveProvider(batch);
      const correlation = await provider.findBatchByCorrelation({
        logicalBatchId: batchId, ...(batch.inputFileId ? { inputFileId: batch.inputFileId } : {}),
      });
      if (correlation.kind === "match") {
        const route = routeTranslationBatchCorrelation(correlation.batch.status);
        const status = route === "completed" ? "PROVIDER_COMPLETED" : "SUBMITTED";
        const changed = await this.repository.db.$executeRaw(Prisma.sql`
          UPDATE "whatsapp"."WhatsAppTemplateTranslationBatch"
          SET "status" = ${status}, "providerBatchId" = ${correlation.batch.providerBatchId},
            "inputFileId" = ${correlation.batch.inputFileId},
            "outputFileId" = ${correlation.batch.outputFileId},
            "errorFileId" = ${correlation.batch.errorFileId},
            "submittedAt" = COALESCE("submittedAt", NOW()),
            "pollSequence" = GREATEST("pollSequence", 1),
            "nextPollAt" = NOW(), "failureCode" = NULL, "updatedAt" = NOW()
          WHERE "id" = ${batchId} AND "status" IN ('SUBMISSION_UNKNOWN', 'SUBMITTING')
        `);
        return changed === 1 ? "recovered" : "ambiguous";
      }
      if (correlation.kind === "conflict") {
        logger.error("background.template_translation.correlation_conflict", { batchId, runId: batch.id });
        await this.repository.markBatchTerminal(batch, "PROVIDER_CORRELATION_CONFLICT", { maxRetries: 0, retrySeconds: 0 });
        return "ambiguous";
      }
      if (ageMs > 24 * 60 * 60_000) {
        logger.error("background.template_translation.orphan_batch_expired", { batchId, runId: batch.id });
        await this.repository.markBatchTerminal(batch, "PROVIDER_CORRELATION_UNRESOLVED", { maxRetries: 0, retrySeconds: 0 });
      } else {
        logger.warn("background.template_translation.correlation_pending", { batchId, runId: batch.id });
      }
      return "ambiguous";
    } catch (error) {
      logger.error("background.template_translation.correlation_exception", {
        batchId, runId: batch.id, error, errorName: error instanceof Error ? error.name.slice(0, 128) : "unknown",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async close(): Promise<void> { await this.queue.close?.(); }
}

export const templateTranslationCoordinator = new TemplateTranslationCoordinator();
export const executeTemplateTranslation = (runId: string): Promise<TranslationRunOutcome> =>
  templateTranslationCoordinator.executeTemplateTranslation(runId);
