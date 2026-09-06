import { randomUUID } from "node:crypto";

import { Queue } from "bullmq";
import { Prisma } from "@prisma/client";
import {
  createTranslationBatchSubmitJobId,
} from "@modainteract/moda-interact-shared/merchant-communications/node";
import {
  MERCHANT_COMMUNICATIONS_JOB_NAMES,
  MERCHANT_COMMUNICATIONS_QUEUE_NAME,
  TranslationDispatchJobSchema,
  type TranslationBatchSubmitJob,
  type TranslationDispatchJob,
} from "../domain/translation-batch.js";
import prisma from "../lib/db.js";
import { connectionRedis } from "../lib/redis.js";

const DEFAULT_MAX_REQUESTS = 100;

type TranslationCandidate = {
  id: string;
  direction: string;
  sourceLanguageTag: string;
  targetLanguageTag: string;
  sourceText: string;
};

type TranslationBatchAssemblyResult = {
  batchId: string | null;
  translationIds: string[];
  submitJobId: string | null;
};

type TranslationBatchQueue = Pick<
  Queue,
  "add"
>;

type TranslationBatchDatabase = {
  $transaction<T>(
    callback: (transaction: {
      $queryRaw<T>(query: Prisma.Sql): Promise<T>;
      $executeRaw(query: Prisma.Sql): Promise<number>;
    }) => Promise<T>,
  ): Promise<T>;
};

function configuredMaxRequests(): number {
  const configured = Number.parseInt(
    process.env.TRANSLATION_BATCH_MAX_REQUESTS ?? "",
    10,
  );
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_REQUESTS;
}

function configuredProvider(): string {
  return process.env.TRANSLATION_PROVIDER?.trim() || "openai";
}

function configuredModel(): string {
  const model = process.env.TRANSLATION_MODEL?.trim();
  if (!model) {
    throw new Error("TRANSLATION_MODEL environment variable is not set");
  }
  return model;
}

export class TranslationBatchAssemblyService {
  private readonly queue: TranslationBatchQueue;
  private readonly maxRequests: number;
  private readonly database: TranslationBatchDatabase;

  constructor(options: {
    queue?: TranslationBatchQueue;
    maxRequests?: number;
    database?: TranslationBatchDatabase;
  } = {}) {
    this.queue = options.queue ?? new Queue(MERCHANT_COMMUNICATIONS_QUEUE_NAME, {
      connection: connectionRedis,
    });
    this.maxRequests = options.maxRequests ?? configuredMaxRequests();
    this.database = options.database ?? prisma;
  }

  async assembleFromDispatch(
    input: unknown,
  ): Promise<TranslationBatchAssemblyResult> {
    const dispatch = TranslationDispatchJobSchema.parse(input);
    const result = await this.database.$transaction(async (transaction) => {
      const candidates = await transaction.$queryRaw<TranslationCandidate[]>(Prisma.sql`
        SELECT
          t."id",
          t."direction",
          t."sourceLanguageTag",
          t."targetLanguageTag",
          m."originalBody" AS "sourceText"
        FROM "support"."MerchantMessageTranslation" t
        INNER JOIN "support"."MerchantSupportMessage" m ON m."id" = t."messageId"
        WHERE t."status" = 'PENDING'
          AND t."currentBatchId" IS NULL
          AND (t."nextAttemptAt" IS NULL OR t."nextAttemptAt" <= NOW())
        ORDER BY t."createdAt", t."id"
        FOR UPDATE OF t SKIP LOCKED
        LIMIT ${this.maxRequests}
      `);

      if (candidates.length === 0) {
        return {
          batchId: null,
          translationIds: [],
        };
      }

      const batchId = randomUUID();
      await transaction.$executeRaw(Prisma.sql`
  INSERT INTO "support"."MerchantTranslationBatch" (
    "id",
    "provider",
    "model",
    "status",
    "updatedAt"
  )
  VALUES (
    ${batchId},
    ${configuredProvider()},
    ${configuredModel()},
    'READY',
    NOW()
  )
      `);

      for (const candidate of candidates) {
          const itemId = randomUUID();
        const providerCustomId = `translation-${candidate.id}-${batchId}`;
        await transaction.$executeRaw(Prisma.sql`
    INSERT INTO "support"."MerchantTranslationBatchItem" (
      "id",
      "batchId",
      "translationId",
      "providerCustomId"
    )
    VALUES (
      ${itemId},
      ${batchId},
      ${candidate.id},
      ${providerCustomId}
    )
  `);

        await transaction.$executeRaw(Prisma.sql`
    UPDATE "support"."MerchantMessageTranslation"
    SET
      "currentBatchId" = ${batchId},
      "updatedAt" = NOW()
    WHERE "id" = ${candidate.id}
        `);
      }

      return {
        batchId,
        translationIds: candidates.map((candidate) => candidate.id),
      };
    });

    if (!result.batchId) {
      return {
        ...result,
        submitJobId: null,
      };
    }

    const submitJob: TranslationBatchSubmitJob = {
      schemaVersion: 1,
      translationBatchId: result.batchId,
    };
    const submitJobId = createTranslationBatchSubmitJobId(result.batchId);

    try {
      await this.queue.add(
        MERCHANT_COMMUNICATIONS_JOB_NAMES.TRANSLATION_BATCH_SUBMIT,
        submitJob,
        { jobId: submitJobId },
      );
    } catch (error) {
      console.error("translation batch submit enqueue failed", error);
    }

    return {
      ...result,
      submitJobId,
    };
  }
}

export const translationBatchAssemblyService = new TranslationBatchAssemblyService();
