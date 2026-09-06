import { Queue } from "bullmq";
import { Prisma } from "@prisma/client";
import {
  createTranslationBatchPollJobId,
  createTranslationBatchResultsJobId,
} from "@modainteract/moda-interact-shared/merchant-communications/node";
import {
  MERCHANT_COMMUNICATIONS_JOB_NAMES,
  MERCHANT_COMMUNICATIONS_QUEUE_NAME,
  type TranslationBatchPollJob,
} from "@modainteract/moda-interact-shared/merchant-communications";

import {
  createOpenAITranslationProvider,
  type TranslationProvider,
} from "../providers/translation.provider.js";
import prisma from "../lib/db.js";
import { connectionRedis } from "../lib/redis.js";

const DEFAULT_POLL_INTERVAL_MINUTES = 5;
const MAX_POLL_INTERVAL_MINUTES = 24 * 60;
const DEFAULT_MAX_AUTO_RETRIES = 3;
const MAX_AUTO_RETRIES = 10;

type PollBatch = {
  id: string;
  provider: string;
  model: string;
  providerBatchId: string | null;
  status: string;
  pollSequence: number;
};

type TerminalItem = {
  translationId: string;
  messageId: string;
  kind: "ADMINISTRATIVE" | "SYSTEM" | "MERCHANT";
  retryCount: number;
};

type PollTransaction = {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
};

type PollDatabase = {
  $transaction<T>(callback: (transaction: PollTransaction) => Promise<T>): Promise<T>;
};

type PollQueue = Pick<Queue, "add">;
type ProviderFactory = (options: { provider: string; model: string }) => TranslationProvider;

function configuredPollMinutes(): number {
  const value = Number.parseInt(process.env.TRANSLATION_BATCH_POLL_INTERVAL_MINUTES ?? "", 10);
  return Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_POLL_INTERVAL_MINUTES)
    : DEFAULT_POLL_INTERVAL_MINUTES;
}

function configuredMaxAutoRetries(): number {
  const value = Number.parseInt(process.env.TRANSLATION_MAX_AUTO_RETRIES ?? "", 10);
  return Number.isInteger(value) && value >= 0
    ? Math.min(value, MAX_AUTO_RETRIES)
    : DEFAULT_MAX_AUTO_RETRIES;
}

function failureIsRetryable(failureCode: string | null): boolean {
  if (!failureCode) return true;
  const normalized = failureCode.toLowerCase();
  const httpStatus = normalized.match(/\bhttp[-_: ]?(\d{3})\b/)?.[1];
  if (httpStatus) {
    const status = Number(httpStatus);
    return status === 429 || status >= 500;
  }
  return !/(auth|permission|invalid|malformed|unsupported|content_policy|bad_request)/.test(normalized);
}

export type TranslationBatchPollResult =
  | { status: "stale"; batchId: string }
  | { status: "rescheduled"; batchId: string; pollSequence: number }
  | { status: "completed"; batchId: string }
  | { status: "terminal"; batchId: string; providerStatus: string };

export class TranslationBatchPollService {
  private readonly database: PollDatabase;
  private readonly providerFactory: ProviderFactory;
  private readonly queue: PollQueue;

  constructor(options: {
    database?: PollDatabase;
    providerFactory?: ProviderFactory;
    queue?: PollQueue;
  } = {}) {
    this.database = options.database ?? prisma;
    this.providerFactory = options.providerFactory ?? ((providerOptions) =>
      createOpenAITranslationProvider(providerOptions));
    this.queue = options.queue ?? new Queue(MERCHANT_COMMUNICATIONS_QUEUE_NAME, {
      connection: connectionRedis,
    });
  }

  async poll(input: TranslationBatchPollJob): Promise<TranslationBatchPollResult> {
    const batch = await this.loadBatch(input.translationBatchId);
    if (
      !batch ||
      batch.status !== "SUBMITTED" ||
      batch.pollSequence !== input.pollSequence ||
      !batch.providerBatchId
    ) {
      return { status: "stale", batchId: input.translationBatchId };
    }

    let providerBatch;
    try {
      const provider = this.providerFactory({ provider: batch.provider, model: batch.model });
      providerBatch = await provider.retrieveBatch(batch.providerBatchId);
    } catch (error) {
      const nextSequence = await this.rescheduleAfterReadFailure(batch);
      await this.enqueuePoll(batch.id, nextSequence);
      console.error("translation batch poll failed", error);
      return { status: "rescheduled", batchId: batch.id, pollSequence: nextSequence };
    }

    if (providerBatch.status === "nonterminal") {
      const nextSequence = await this.advanceNonterminal(batch);
      await this.enqueuePoll(batch.id, nextSequence);
      return { status: "rescheduled", batchId: batch.id, pollSequence: nextSequence };
    }

    if (providerBatch.status === "completed") {
      const updated = await this.database.$transaction(async (transaction) =>
        transaction.$executeRaw(Prisma.sql`
          UPDATE "support"."MerchantTranslationBatch"
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
      await this.enqueueResults(batch.id);
      return { status: "completed", batchId: batch.id };
    }

    const terminalApplied = await this.persistTerminalBatch(
      batch,
      providerBatch.status,
      providerBatch.failureCode,
    );
    if (!terminalApplied) return { status: "stale", batchId: batch.id };
    return { status: "terminal", batchId: batch.id, providerStatus: providerBatch.status };
  }

  private async loadBatch(batchId: string): Promise<PollBatch | null> {
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<PollBatch[]>(Prisma.sql`
        SELECT "id", "provider", "model", "providerBatchId", "status", "pollSequence"
        FROM "support"."MerchantTranslationBatch"
        WHERE "id" = ${batchId}
      `);
      return rows[0] ?? null;
    });
  }

  private async rescheduleAfterReadFailure(batch: PollBatch): Promise<number> {
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ pollSequence: number }>>(Prisma.sql`
        UPDATE "support"."MerchantTranslationBatch"
        SET
          "lastPolledAt" = NOW(),
          "nextPollAt" = NOW() + (${configuredPollMinutes()} * INTERVAL '1 minute'),
          "pollSequence" = "pollSequence" + 1,
          "failureCode" = 'poll-read-failed',
          "updatedAt" = NOW()
        WHERE "id" = ${batch.id}
          AND "status" = 'SUBMITTED'
          AND "pollSequence" = ${batch.pollSequence}
        RETURNING "pollSequence"
      `);
      return rows[0]?.pollSequence ?? batch.pollSequence;
    });
  }

  private async advanceNonterminal(batch: PollBatch): Promise<number> {
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ pollSequence: number }>>(Prisma.sql`
        UPDATE "support"."MerchantTranslationBatch"
        SET
          "lastPolledAt" = NOW(),
          "nextPollAt" = NOW() + (${configuredPollMinutes()} * INTERVAL '1 minute'),
          "pollSequence" = "pollSequence" + 1,
          "failureCode" = NULL,
          "updatedAt" = NOW()
        WHERE "id" = ${batch.id}
          AND "status" = 'SUBMITTED'
          AND "pollSequence" = ${batch.pollSequence}
        RETURNING "pollSequence"
      `);
      return rows[0]?.pollSequence ?? batch.pollSequence;
    });
  }

  private async persistTerminalBatch(
    batch: PollBatch,
    providerStatus: string,
    failureCode: string | null,
  ): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const claimed = await transaction.$executeRaw(Prisma.sql`
        UPDATE "support"."MerchantTranslationBatch"
        SET
          "status" = ${providerStatus.toUpperCase()},
          "lastPolledAt" = NOW(),
          "nextPollAt" = NULL,
          "failureCode" = ${failureCode ?? providerStatus},
          "updatedAt" = NOW()
        WHERE "id" = ${batch.id}
          AND "status" = 'SUBMITTED'
          AND "pollSequence" = ${batch.pollSequence}
      `);
      if (claimed !== 1) return false;

      const items = await transaction.$queryRaw<TerminalItem[]>(Prisma.sql`
        SELECT i."translationId", t."messageId", m."kind", t."retryCount"
        FROM "support"."MerchantTranslationBatchItem" i
        INNER JOIN "support"."MerchantMessageTranslation" t ON t."id" = i."translationId"
        INNER JOIN "support"."MerchantSupportMessage" m ON m."id" = t."messageId"
        WHERE i."batchId" = ${batch.id}
      `);
      const retryable = failureIsRetryable(failureCode);
      for (const item of items) {
        const shouldRetry = retryable && item.retryCount < configuredMaxAutoRetries();
        const affected = await transaction.$executeRaw(Prisma.sql`
          UPDATE "support"."MerchantMessageTranslation"
          SET
            "status" = ${shouldRetry ? "PENDING" : "FAILED"},
            "currentBatchId" = NULL,
            "retryCount" = "retryCount" + ${shouldRetry ? 1 : 0},
            "nextAttemptAt" = ${shouldRetry ? new Date(Date.now() + configuredPollMinutes() * 60_000) : null},
            "failureCode" = ${failureCode ?? providerStatus},
            "updatedAt" = NOW()
          WHERE "id" = ${item.translationId}
            AND "status" = 'PENDING'
            AND "currentBatchId" = ${batch.id}
        `);
        if (affected === 1 && !shouldRetry && item.kind !== "MERCHANT") {
          await transaction.$executeRaw(Prisma.sql`
            UPDATE "support"."MerchantSupportMessage"
            SET "state" = 'FAILED', "updatedAt" = NOW()
            WHERE "id" = ${item.messageId}
              AND "kind" IN ('ADMINISTRATIVE', 'SYSTEM')
              AND "state" = 'PROCESSING'
          `);
        }
      }
      return true;
    });
  }

  private async enqueuePoll(batchId: string, pollSequence: number): Promise<void> {
    const job: TranslationBatchPollJob = {
      schemaVersion: 1,
      translationBatchId: batchId,
      pollSequence,
    };
    try {
      await this.queue.add(
        MERCHANT_COMMUNICATIONS_JOB_NAMES.TRANSLATION_BATCH_POLL,
        job,
        {
          jobId: createTranslationBatchPollJobId(batchId, pollSequence),
          delay: configuredPollMinutes() * 60_000,
        },
      );
    } catch (error) {
      console.error("translation batch poll enqueue failed", error);
    }
  }

  private async enqueueResults(batchId: string): Promise<void> {
    try {
      await this.queue.add(
        MERCHANT_COMMUNICATIONS_JOB_NAMES.TRANSLATION_BATCH_RESULTS,
        { schemaVersion: 1, translationBatchId: batchId },
        { jobId: createTranslationBatchResultsJobId(batchId) },
      );
    } catch (error) {
      console.error("translation batch results enqueue failed", error);
    }
  }
}

export const translationBatchPollService = new TranslationBatchPollService();

export const translationBatchPollTestInternals = {
  configuredPollMinutes,
  configuredMaxAutoRetries,
  failureIsRetryable,
};
