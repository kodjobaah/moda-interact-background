import { Prisma } from "@prisma/client";
import { Queue } from "bullmq";
import {
  createTranslationBatchPollJobId,
  createTranslationBatchResultsJobId,
  createTranslationBatchSubmitJobId,
  createTranslationDispatchJobId,
  createTranslationReconcileJobId,
} from "@modainteract/moda-interact-shared/merchant-communications/node";
import {
  MERCHANT_COMMUNICATIONS_JOB_NAMES,
  MERCHANT_COMMUNICATIONS_QUEUE_NAME,
  MERCHANT_COMMUNICATIONS_SCHEMA_VERSION,
  type TranslationBatchPollJob,
  type TranslationBatchResultsJob,
  type TranslationBatchSubmitJob,
  type TranslationDispatchJob,
} from "@modainteract/moda-interact-shared/merchant-communications";

import prisma from "../lib/db.js";
import { connectionRedis } from "../lib/redis.js";
import { createOpenAITranslationProvider, type TranslationProvider } from "../providers/translation.provider.js";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_INTERVAL_MINUTES = 5;
const DEFAULT_REQUEST_CLAIM_TIMEOUT_MINUTES = 15;
const HEALTHY_STATES = new Set(["waiting", "delayed", "active"]);
const TERMINAL_BATCH_STATUSES = ["FAILED", "EXPIRED", "CANCELLED"] as const;

type ReconciliationQueue = Pick<Queue, "add" | "getJob"> & { close?: () => Promise<void> };
type ReconciliationDatabase = Pick<typeof prisma, "$queryRaw" | "$executeRaw" | "$transaction">;

type ExpectedJob = {
  id: string;
  name: string;
  data: unknown;
};

type BatchRecoveryRow = {
  id: string;
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

export type TranslationReconciliationResult = {
  repairedJobs: number;
  requestsProcessed: number;
  correlationConflicts: number;
};

function pageSize(): number {
  const value = Number.parseInt(process.env.TRANSLATION_RECONCILIATION_PAGE_SIZE ?? "", 10);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 500) : DEFAULT_PAGE_SIZE;
}

function requestClaimTimeoutMs(): number {
  const value = Number.parseInt(process.env.TRANSLATION_RECONCILIATION_CLAIM_TIMEOUT_MINUTES ?? "", 10);
  const minutes = Number.isInteger(value) && value > 0 ? value : DEFAULT_REQUEST_CLAIM_TIMEOUT_MINUTES;
  return minutes * 60_000;
}

export function reconciliationIntervalMs(): number {
  const value = Number.parseInt(process.env.TRANSLATION_RECONCILIATION_INTERVAL_MINUTES ?? "", 10);
  const minutes = Number.isInteger(value) && value > 0 ? value : DEFAULT_INTERVAL_MINUTES;
  return minutes * 60_000;
}

export class TranslationReconciliationService {
  private readonly queue: ReconciliationQueue;
  private readonly database: ReconciliationDatabase;
  private readonly providerFactory: (options: { provider: string; model: string }) => TranslationProvider;

  constructor(options: {
    queue?: ReconciliationQueue;
    database?: ReconciliationDatabase;
    providerFactory?: (options: { provider: string; model: string }) => TranslationProvider;
  } = {}) {
    this.queue = options.queue ?? new Queue(MERCHANT_COMMUNICATIONS_QUEUE_NAME, { connection: connectionRedis });
    this.database = options.database ?? prisma;
    this.providerFactory = options.providerFactory ?? ((providerOptions) => createOpenAITranslationProvider(providerOptions));
  }

  async reconcile(reconciliationRequestId?: string): Promise<TranslationReconciliationResult> {
    const result: TranslationReconciliationResult = {
      repairedJobs: 0,
      requestsProcessed: 0,
      correlationConflicts: 0,
    };

    const translations = await this.database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT t."id"
      FROM "support"."MerchantMessageTranslation" t
      WHERE t."status" = 'PENDING'
        AND t."currentBatchId" IS NULL
        AND (t."nextAttemptAt" IS NULL OR t."nextAttemptAt" <= NOW())
      ORDER BY t."createdAt", t."id"
      LIMIT ${pageSize()}
    `);
    for (const translation of translations) {
      result.repairedJobs += await this.ensureJob({
        id: createTranslationDispatchJobId(translation.id),
        name: MERCHANT_COMMUNICATIONS_JOB_NAMES.TRANSLATION_DISPATCH,
        data: { schemaVersion: MERCHANT_COMMUNICATIONS_SCHEMA_VERSION, translationId: translation.id } satisfies TranslationDispatchJob,
      });
    }

    const readyBatches = await this.database.$queryRaw<BatchRecoveryRow[]>(Prisma.sql`
      SELECT "id", "status", "pollSequence", "provider", "model", "inputFileId", "providerBatchId", "submissionStartedAt", "outputFileId", "errorFileId"
      FROM "support"."MerchantTranslationBatch"
      WHERE "status" = 'READY' AND ("nextSubmitAt" IS NULL OR "nextSubmitAt" <= NOW())
      ORDER BY "createdAt", "id"
      LIMIT ${pageSize()}
    `);
    for (const batch of readyBatches ?? []) {
      result.repairedJobs += await this.ensureSubmitJob(batch.id);
    }

    const duePollBatches = await this.database.$queryRaw<BatchRecoveryRow[]>(Prisma.sql`
      SELECT "id", "status", "pollSequence", "provider", "model", "inputFileId", "providerBatchId", "submissionStartedAt", "outputFileId", "errorFileId"
      FROM "support"."MerchantTranslationBatch"
      WHERE "status" = 'SUBMITTED' AND ("nextPollAt" IS NULL OR "nextPollAt" <= NOW())
      ORDER BY "createdAt", "id"
      LIMIT ${pageSize()}
    `);
    for (const batch of duePollBatches ?? []) {
      result.repairedJobs += await this.ensurePollJob(batch);
    }

    const completedBatches = await this.database.$queryRaw<BatchRecoveryRow[]>(Prisma.sql`
      SELECT "id", "status", "pollSequence", "provider", "model", "inputFileId", "providerBatchId", "submissionStartedAt", "outputFileId", "errorFileId"
      FROM "support"."MerchantTranslationBatch"
      WHERE "status" = 'PROVIDER_COMPLETED'
      ORDER BY "createdAt", "id"
      LIMIT ${pageSize()}
    `);
    for (const batch of completedBatches ?? []) {
      result.repairedJobs += await this.ensureResultsJob(batch.id);
    }

    const unknownBatches = await this.database.$queryRaw<BatchRecoveryRow[]>(Prisma.sql`
      SELECT "id", "status", "pollSequence", "provider", "model", "inputFileId", "providerBatchId", "submissionStartedAt", "outputFileId", "errorFileId"
      FROM "support"."MerchantTranslationBatch"
      WHERE "status" = 'SUBMISSION_UNKNOWN'
      ORDER BY "lastSubmitAttemptAt" NULLS FIRST, "createdAt", "id"
      LIMIT ${pageSize()}
    `);
    for (const batch of unknownBatches ?? []) {
      const correlation = await this.reconcileUnknownBatch(batch);
      result.correlationConflicts += correlation === "conflict" ? 1 : 0;
      if (correlation === "completed") result.repairedJobs += await this.ensureResultsJob(batch.id);
      if (correlation === "poll") result.repairedJobs += await this.ensurePollJob(batch);
    }

    await this.queue.getJob(createTranslationReconcileJobId("availability-check"));
    const requests = await this.claimRequests(reconciliationRequestId);
    for (const request of requests ?? []) {
      await this.processRequest(request.id, request.scope, request.translationId);
      result.requestsProcessed += 1;
    }
    return result;
  }

  async enqueuePeriodicReconciliation(): Promise<void> {
    await this.queue.add(
      MERCHANT_COMMUNICATIONS_JOB_NAMES.TRANSLATION_RECONCILE,
      { schemaVersion: MERCHANT_COMMUNICATIONS_SCHEMA_VERSION },
      { jobId: createTranslationReconcileJobId() },
    );
  }

  async close(): Promise<void> {
    await this.queue.close?.();
  }

  private async ensureJob(expected: ExpectedJob): Promise<number> {
    const existing = await this.queue.getJob(expected.id);
    if (existing) {
      const state = await existing.getState();
      if (HEALTHY_STATES.has(state)) return 0;
      await existing.remove();
    }
    await this.queue.add(expected.name, expected.data, { jobId: expected.id });
    return 1;
  }

  private async ensureSubmitJob(batchId: string): Promise<number> {
    return this.ensureJob({
      id: createTranslationBatchSubmitJobId(batchId),
      name: MERCHANT_COMMUNICATIONS_JOB_NAMES.TRANSLATION_BATCH_SUBMIT,
      data: { schemaVersion: MERCHANT_COMMUNICATIONS_SCHEMA_VERSION, translationBatchId: batchId } satisfies TranslationBatchSubmitJob,
    });
  }

  private async ensurePollJob(batch: Pick<BatchRecoveryRow, "id" | "pollSequence">): Promise<number> {
    return this.ensureJob({
      id: createTranslationBatchPollJobId(batch.id, batch.pollSequence),
      name: MERCHANT_COMMUNICATIONS_JOB_NAMES.TRANSLATION_BATCH_POLL,
      data: { schemaVersion: MERCHANT_COMMUNICATIONS_SCHEMA_VERSION, translationBatchId: batch.id, pollSequence: batch.pollSequence } satisfies TranslationBatchPollJob,
    });
  }

  private async ensureResultsJob(batchId: string): Promise<number> {
    return this.ensureJob({
      id: createTranslationBatchResultsJobId(batchId),
      name: MERCHANT_COMMUNICATIONS_JOB_NAMES.TRANSLATION_BATCH_RESULTS,
      data: { schemaVersion: MERCHANT_COMMUNICATIONS_SCHEMA_VERSION, translationBatchId: batchId } satisfies TranslationBatchResultsJob,
    });
  }

  private async reconcileUnknownBatch(batch: {
    id: string;
    provider: string;
    model: string;
    inputFileId: string | null;
    submissionStartedAt: Date | null;
  }): Promise<"poll" | "completed" | "none" | "conflict" | "stale"> {
    const provider = this.providerFactory({ provider: batch.provider, model: batch.model });
    const submittedAfter = batch.submissionStartedAt
      ? new Date(batch.submissionStartedAt.getTime() - requestClaimTimeoutMs())
      : undefined;
    const correlation = await provider.findBatchByCorrelation({
      logicalBatchId: batch.id,
      ...(batch.inputFileId ? { inputFileId: batch.inputFileId } : {}),
      ...(submittedAfter ? { submittedAfter } : {}),
    });
    if (correlation.kind === "conflict") {
      await this.database.$executeRaw(Prisma.sql`
        UPDATE "support"."MerchantTranslationBatch"
        SET "failureCode" = 'CORRELATION_CONFLICT', "updatedAt" = NOW()
        WHERE "id" = ${batch.id} AND "status" = 'SUBMISSION_UNKNOWN'
      `);
      return "conflict";
    }
    if (correlation.kind === "none") return "none";
    const completed = correlation.batch.status === "completed";
    const affectedRows = await this.database.$executeRaw(Prisma.sql`
      UPDATE "support"."MerchantTranslationBatch"
      SET "providerBatchId" = ${correlation.batch.providerBatchId},
          "inputFileId" = COALESCE("inputFileId", ${correlation.batch.inputFileId}),
          "outputFileId" = ${correlation.batch.outputFileId},
          "errorFileId" = ${correlation.batch.errorFileId},
          "status" = ${completed ? "PROVIDER_COMPLETED" : "SUBMITTED"},
          "nextPollAt" = CASE WHEN ${completed} THEN "nextPollAt" ELSE NOW() END,
          "updatedAt" = NOW()
      WHERE "id" = ${batch.id} AND "status" = 'SUBMISSION_UNKNOWN'
    `);
    if (affectedRows !== 1) return "stale";
    return completed ? "completed" : "poll";
  }

  private async claimRequests(requestId?: string): Promise<Array<{ id: string; scope: string; translationId: string | null }>> {
    const staleBefore = new Date(Date.now() - requestClaimTimeoutMs());
    return this.database.$queryRaw(Prisma.sql`
      UPDATE "support"."MerchantTranslationReconciliationRequest"
      SET "status" = 'PROCESSING', "startedAt" = NOW()
      WHERE "id" IN (
        SELECT "id"
        FROM "support"."MerchantTranslationReconciliationRequest"
        WHERE ("status" = 'PENDING' OR ("status" = 'PROCESSING' AND "startedAt" < ${staleBefore}))
          ${requestId ? Prisma.sql`AND "id" = ${requestId}` : Prisma.empty}
        ORDER BY "requestedAt", "id"
        LIMIT ${requestId ? 1 : pageSize()}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "scope", "translationId"
    `);
  }

  private async processRequest(id: string, scope: string, translationId: string | null): Promise<void> {
    try {
      if (scope === "TRANSLATION" && translationId) {
        await this.reconcileTargetedTranslation(translationId);
      } else if (scope === "FAILED_TRANSLATIONS") {
        const restored = await this.database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "support"."MerchantMessageTranslation"
          SET "currentBatchId" = NULL, "status" = 'PENDING', "nextAttemptAt" = NOW(), "retryCount" = "retryCount" + 1, "failureCode" = NULL, "updatedAt" = NOW()
          WHERE "status" = 'FAILED'
            AND "id" IN (
              SELECT "id"
              FROM "support"."MerchantMessageTranslation"
              WHERE "status" = 'FAILED'
                AND ("currentBatchId" IS NULL OR EXISTS (
                  SELECT 1 FROM "support"."MerchantTranslationBatch" b
                  WHERE b."id" = "currentBatchId" AND b."status" IN ('FAILED', 'EXPIRED', 'CANCELLED')
                ))
              ORDER BY "createdAt", "id"
              LIMIT ${pageSize()}
            )
          RETURNING "id"
        `);
        for (const translation of restored) {
          await this.ensureJob({
            id: createTranslationDispatchJobId(translation.id),
            name: MERCHANT_COMMUNICATIONS_JOB_NAMES.TRANSLATION_DISPATCH,
            data: { schemaVersion: MERCHANT_COMMUNICATIONS_SCHEMA_VERSION, translationId: translation.id } satisfies TranslationDispatchJob,
          });
        }
        const remaining = await this.database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT t."id"
          FROM "support"."MerchantMessageTranslation" t
          WHERE t."status" = 'FAILED'
            AND (t."currentBatchId" IS NULL OR EXISTS (
              SELECT 1 FROM "support"."MerchantTranslationBatch" b
              WHERE b."id" = t."currentBatchId" AND b."status" IN ('FAILED', 'EXPIRED', 'CANCELLED')
            ))
          ORDER BY t."createdAt", t."id"
          LIMIT 1
        `);
        if (remaining.length > 0) {
          await this.database.$executeRaw(Prisma.sql`
            UPDATE "support"."MerchantTranslationReconciliationRequest"
            SET "status" = 'PENDING', "startedAt" = NULL, "failureCode" = NULL
            WHERE "id" = ${id} AND "status" = 'PROCESSING'
          `);
          return;
        }
      }
      await this.database.$executeRaw(Prisma.sql`
        UPDATE "support"."MerchantTranslationReconciliationRequest"
        SET "status" = 'COMPLETED', "failureCode" = NULL, "completedAt" = NOW()
        WHERE "id" = ${id} AND "status" = 'PROCESSING'
      `);
    } catch (error) {
      await this.database.$executeRaw(Prisma.sql`
        UPDATE "support"."MerchantTranslationReconciliationRequest"
        SET "status" = 'PENDING', "failureCode" = ${error instanceof Error ? error.name : "RECONCILIATION_FAILED"}
        WHERE "id" = ${id} AND "status" = 'PROCESSING'
      `);
      throw error;
    }
  }

  private async reconcileTargetedTranslation(translationId: string): Promise<void> {
    const rows = await this.database.$queryRaw<Array<{
      id: string;
      status: string;
      currentBatchId: string | null;
      batchStatus: string | null;
      pollSequence: number | null;
    }>>(Prisma.sql`
      SELECT t."id", t."status", t."currentBatchId", b."status" AS "batchStatus", b."pollSequence"
      FROM "support"."MerchantMessageTranslation" t
      LEFT JOIN "support"."MerchantTranslationBatch" b ON b."id" = t."currentBatchId"
      WHERE t."id" = ${translationId}
    `);
    const translation = rows[0];
    if (!translation) return;

    if (translation.currentBatchId && translation.batchStatus) {
      if (translation.batchStatus === "READY") {
        await this.ensureSubmitJob(translation.currentBatchId);
      } else if (translation.batchStatus === "SUBMITTED") {
        await this.ensurePollJob({ id: translation.currentBatchId, pollSequence: translation.pollSequence ?? 0 });
      } else if (translation.batchStatus === "PROVIDER_COMPLETED") {
        await this.ensureResultsJob(translation.currentBatchId);
      } else if (translation.batchStatus === "SUBMISSION_UNKNOWN") {
        const batch = await this.database.$queryRaw<BatchRecoveryRow[]>(Prisma.sql`
          SELECT "id", "status", "pollSequence", "provider", "model", "inputFileId", "providerBatchId", "submissionStartedAt", "outputFileId", "errorFileId"
          FROM "support"."MerchantTranslationBatch" WHERE "id" = ${translation.currentBatchId}
        `);
        const correlation = batch[0] ? await this.reconcileUnknownBatch(batch[0]) : "stale";
        if (correlation === "completed") await this.ensureResultsJob(translation.currentBatchId);
        if (correlation === "poll") await this.ensurePollJob({ id: translation.currentBatchId, pollSequence: translation.pollSequence ?? 0 });
      } else if (translation.status === "FAILED" && TERMINAL_BATCH_STATUSES.includes(translation.batchStatus as typeof TERMINAL_BATCH_STATUSES[number])) {
        await this.restoreTranslation(translationId);
        await this.ensureDispatchJob(translationId);
      }
      return;
    }

    if (translation.status !== "FAILED") return;
    if (await this.restoreTranslation(translationId)) await this.ensureDispatchJob(translationId);
  }

  private async ensureDispatchJob(translationId: string): Promise<number> {
    return this.ensureJob({
      id: createTranslationDispatchJobId(translationId),
      name: MERCHANT_COMMUNICATIONS_JOB_NAMES.TRANSLATION_DISPATCH,
      data: { schemaVersion: MERCHANT_COMMUNICATIONS_SCHEMA_VERSION, translationId } satisfies TranslationDispatchJob,
    });
  }

  private async restoreTranslation(translationId: string): Promise<boolean> {
    const rows = await this.database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "support"."MerchantMessageTranslation" t
      SET "currentBatchId" = NULL, "status" = 'PENDING', "nextAttemptAt" = NOW(), "retryCount" = "retryCount" + 1, "updatedAt" = NOW()
      WHERE t."id" = ${translationId}
        AND t."status" = 'FAILED'
        AND (t."currentBatchId" IS NULL OR EXISTS (
          SELECT 1 FROM "support"."MerchantTranslationBatch" b
          WHERE b."id" = t."currentBatchId" AND b."status" IN ('FAILED', 'EXPIRED', 'CANCELLED')
        ))
      RETURNING t."id"
    `);
    return rows.length === 1;
  }
}

export const translationReconciliationService = new TranslationReconciliationService();