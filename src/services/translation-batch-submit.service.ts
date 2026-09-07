import { Queue } from "bullmq";
import { Prisma } from "@prisma/client";
import { createTranslationBatchPollJobId } from "@modainteract/moda-interact-shared/merchant-communications/node";
import {
  MERCHANT_COMMUNICATIONS_JOB_NAMES,
  MERCHANT_COMMUNICATIONS_QUEUE_NAME,
  MERCHANT_COMMUNICATIONS_SCHEMA_VERSION,
  type TranslationBatchPollJob,
} from "@modainteract/moda-interact-shared/merchant-communications";

import {
  createOpenAITranslationProvider,
  type TranslationProvider,
  type TranslationRequest,
} from "../providers/translation.provider.js";
import prisma from "../lib/db.js";
import { connectionRedis } from "../lib/redis.js";

const DEFAULT_RETRY_MINUTES = 5;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_POLL_MINUTES = 5;
const MAX_RETRY_MINUTES = 24 * 60;
const MAX_MAX_ATTEMPTS = 10;
const MAX_INITIAL_POLL_MINUTES = 24 * 60;

export type SubmitFailureClassification =
  | "DEFINITE_RETRYABLE_NOT_CREATED"
  | "DEFINITE_TERMINAL_NOT_CREATED"
  | "AMBIGUOUS_CREATE";

type BatchToSubmit = {
  id: string;
  provider: string;
  model: string;
  inputFileId: string | null;
  submitAttemptCount: number;
};

type BatchItemRequest = TranslationRequest & {
  providerCustomId: string;
};

type SubmissionDatabase = {
  $transaction<T>(
    callback: (transaction: {
      $queryRaw<T>(query: Prisma.Sql): Promise<T>;
      $executeRaw(query: Prisma.Sql): Promise<number>;
    }) => Promise<T>,
  ): Promise<T>;
};

type SubmissionQueue = Pick<Queue, "add">;

type FailureLike = {
  classification?: SubmitFailureClassification;
  submissionClassification?: SubmitFailureClassification;
};

type ProviderFactory = (options: {
  provider: string;
  model: string;
}) => TranslationProvider;

export type TranslationBatchSubmitResult =
  | { status: "claimed"; batchId: string; providerBatchId: string }
  | { status: "skipped"; batchId: string };

export class TranslationBatchSubmissionError extends Error {
  readonly classification: SubmitFailureClassification;

  constructor(
    classification: SubmitFailureClassification,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TranslationBatchSubmissionError";
    this.classification = classification;
  }
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function boundedPositiveInteger(name: string, fallback: number, maximum: number): number {
  return Math.min(positiveInteger(name, fallback), maximum);
}

function retryMinutes(): number {
  return boundedPositiveInteger(
    "TRANSLATION_BATCH_SUBMIT_RETRY_MINUTES",
    DEFAULT_RETRY_MINUTES,
    MAX_RETRY_MINUTES,
  );
}

function maxAttempts(): number {
  return boundedPositiveInteger(
    "TRANSLATION_BATCH_SUBMIT_MAX_ATTEMPTS",
    DEFAULT_MAX_ATTEMPTS,
    MAX_MAX_ATTEMPTS,
  );
}

function initialPollMinutes(): number {
  return boundedPositiveInteger(
    "TRANSLATION_BATCH_INITIAL_POLL_MINUTES",
    DEFAULT_INITIAL_POLL_MINUTES,
    MAX_INITIAL_POLL_MINUTES,
  );
}

function failureClassification(
  error: unknown,
  fallback: SubmitFailureClassification,
): SubmitFailureClassification {
  if (error && typeof error === "object") {
    const candidate = error as FailureLike;
    if (candidate.classification) return candidate.classification;
    if (candidate.submissionClassification) {
      return candidate.submissionClassification;
    }
  }
  return fallback;
}

function failureCode(error: unknown): string {
  if (error instanceof Error) return error.name.slice(0, 120);
  return "provider-submission-failed";
}

export class TranslationBatchSubmitService {
  private readonly database: SubmissionDatabase;
  private readonly provider: TranslationProvider | undefined;
  private readonly providerFactory: ProviderFactory;
  private readonly queue: SubmissionQueue;

  constructor(options: {
    database?: SubmissionDatabase;
    provider?: TranslationProvider;
    providerFactory?: ProviderFactory;
    queue?: SubmissionQueue;
  } = {}) {
    this.database = options.database ?? prisma;
    this.provider = options.provider;
    this.providerFactory = options.providerFactory ?? ((providerOptions) =>
      createOpenAITranslationProvider(providerOptions));
    this.queue = options.queue ?? new Queue(MERCHANT_COMMUNICATIONS_QUEUE_NAME, {
      connection: connectionRedis,
    });
  }

  async submit(input: { translationBatchId: string }): Promise<TranslationBatchSubmitResult> {
    const claimed = await this.claimReadyBatch(input.translationBatchId);
    if (!claimed) {
      return { status: "skipped", batchId: input.translationBatchId };
    }

    let provider: TranslationProvider;
    try {
      provider = this.provider ?? this.providerFactory({
        provider: claimed.provider,
        model: claimed.model,
      });
    } catch (error) {
      await this.persistFailure(
        claimed,
        "DEFINITE_TERMINAL_NOT_CREATED",
        error,
      );
      return { status: "skipped", batchId: claimed.id };
    }

    let inputFileId = claimed.inputFileId;
    try {
      if (!inputFileId) {
        try {
          const requests = await this.loadRequests(claimed.id);
          const prepared = await provider.prepareBatchInput(requests);
          inputFileId = prepared.inputFileId;
          await this.persistInputFileId(claimed.id, inputFileId);
        } catch (error) {
          await this.persistFailure(
            claimed,
            failureClassification(error, "DEFINITE_RETRYABLE_NOT_CREATED"),
            error,
          );
          return { status: "skipped", batchId: claimed.id };
        }
      }

      const providerBatch = await provider.createBatch(claimed.id, inputFileId);
      await this.persistSubmitted(claimed.id, providerBatch.providerBatchId, inputFileId);
      await this.enqueuePoll(claimed.id, 1);
      return {
        status: "claimed",
        batchId: claimed.id,
        providerBatchId: providerBatch.providerBatchId,
      };
    } catch (error) {
      const classification = failureClassification(error, "AMBIGUOUS_CREATE");
      await this.persistFailure(claimed, classification, error);
      if (classification === "AMBIGUOUS_CREATE") throw error;
      return { status: "skipped", batchId: claimed.id };
    }
  }

  private async claimReadyBatch(batchId: string): Promise<BatchToSubmit | null> {
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<BatchToSubmit[]>(Prisma.sql`
        UPDATE "support"."MerchantTranslationBatch"
        SET
          "status" = 'SUBMITTING',
          "submissionStartedAt" = NOW(),
          "lastSubmitAttemptAt" = NOW(),
          "submitAttemptCount" = "submitAttemptCount" + 1,
          "updatedAt" = NOW()
        WHERE "id" = ${batchId}
          AND "status" = 'READY'
          AND ("nextSubmitAt" IS NULL OR "nextSubmitAt" <= NOW())
        RETURNING "id", "provider", "model", "inputFileId", "submitAttemptCount"
      `);
      return rows[0] ?? null;
    });
  }

  private async loadRequests(batchId: string): Promise<BatchItemRequest[]> {
    return this.database.$transaction(async (transaction) => {
      return transaction.$queryRaw<BatchItemRequest[]>(Prisma.sql`
        SELECT
          i."translationId",
          i."providerCustomId",
          t."direction",
          t."sourceLanguageTag",
          t."targetLanguageTag",
          m."originalBody" AS "sourceText"
        FROM "support"."MerchantTranslationBatchItem" i
        INNER JOIN "support"."MerchantMessageTranslation" t
          ON t."id" = i."translationId"
        INNER JOIN "support"."MerchantSupportMessage" m
          ON m."id" = t."messageId"
        WHERE i."batchId" = ${batchId}
        ORDER BY i."createdAt", i."id"
      `);
    });
  }

  private async persistInputFileId(batchId: string, inputFileId: string): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const affectedRows = await transaction.$executeRaw(Prisma.sql`
        UPDATE "support"."MerchantTranslationBatch"
        SET "inputFileId" = ${inputFileId}, "updatedAt" = NOW()
        WHERE "id" = ${batchId} AND "status" = 'SUBMITTING'
      `);
      if (affectedRows !== 1) {
        throw new TranslationBatchSubmissionError(
          "DEFINITE_RETRYABLE_NOT_CREATED",
          "Persisting the translation Batch input file affected an unexpected number of rows",
        );
      }
    });
  }

  private async persistSubmitted(
    batchId: string,
    providerBatchId: string,
    inputFileId: string,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const affectedRows = await transaction.$executeRaw(Prisma.sql`
        UPDATE "support"."MerchantTranslationBatch"
        SET
          "status" = 'SUBMITTED',
          "providerBatchId" = ${providerBatchId},
          "inputFileId" = ${inputFileId},
          "submittedAt" = NOW(),
          "pollSequence" = 1,
          "nextPollAt" = NOW() + (${initialPollMinutes()} * INTERVAL '1 minute'),
          "updatedAt" = NOW()
        WHERE "id" = ${batchId} AND "status" = 'SUBMITTING'
      `);
      if (affectedRows !== 1) {
        throw new TranslationBatchSubmissionError(
          "AMBIGUOUS_CREATE",
          "Persisting the accepted provider Batch affected an unexpected number of rows",
        );
      }
    });
  }

  private async persistFailure(
    batch: BatchToSubmit,
    classification: SubmitFailureClassification,
    error: unknown,
  ): Promise<void> {
    const nextStatus = classification === "AMBIGUOUS_CREATE"
      ? "SUBMISSION_UNKNOWN"
      : classification === "DEFINITE_TERMINAL_NOT_CREATED" ||
          batch.submitAttemptCount >= maxAttempts()
        ? "FAILED"
        : "READY";
    const terminal = nextStatus === "FAILED";
    const nextSubmitAt = terminal || nextStatus !== "READY"
      ? null
      : new Date(Date.now() + retryMinutes() * 60_000);
    await this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`
        UPDATE "support"."MerchantTranslationBatch"
        SET
          "status" = CAST(${nextStatus} AS "support"."MerchantTranslationBatchStatus"),
          "nextSubmitAt" = ${nextSubmitAt},
          "failureCode" = ${failureCode(error)},
          "updatedAt" = NOW()
        WHERE "id" = ${batch.id} AND "status" = 'SUBMITTING'
      `);
    });
  }

  private async enqueuePoll(batchId: string, pollSequence: number): Promise<void> {
    const job: TranslationBatchPollJob = {
      schemaVersion: MERCHANT_COMMUNICATIONS_SCHEMA_VERSION,
      translationBatchId: batchId,
      pollSequence,
    };
    try {
      await this.queue.add(
        MERCHANT_COMMUNICATIONS_JOB_NAMES.TRANSLATION_BATCH_POLL,
        job,
        {
          jobId: createTranslationBatchPollJobId(batchId, pollSequence),
          delay: initialPollMinutes() * 60_000,
        },
      );
    } catch (error) {
      console.error("translation batch poll enqueue failed", error);
    }
  }
}

export const translationBatchSubmitService = new TranslationBatchSubmitService();

export const translationBatchSubmitTestInternals = {
  retryMinutes,
  maxAttempts,
  initialPollMinutes,
};