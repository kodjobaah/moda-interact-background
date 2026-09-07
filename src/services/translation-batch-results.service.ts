import { Prisma } from "@prisma/client";
import { createOpenAITranslationProvider, type TranslationProvider, type TranslationProviderResult } from "../providers/translation.provider.js";
import prisma from "../lib/db.js";

const DEFAULT_RETRY_MINUTES = 5;
const MAX_RETRY_MINUTES = 24 * 60;
const DEFAULT_MAX_AUTO_RETRIES = 3;
const MAX_AUTO_RETRIES = 10;

type ResultBatch = {
  id: string;
  provider: string;
  model: string;
  status: string;
  outputFileId: string | null;
  errorFileId: string | null;
  providerBatchId: string | null;
};

type ExpectedItem = {
  providerCustomId: string;
  translationId: string;
};

type TranslationRecord = {
  translationId: string;
  messageId: string;
  threadId: string;
  kind: "ADMINISTRATIVE" | "SYSTEM" | "MERCHANT";
  translationStatus: "PENDING" | "AVAILABLE" | "FAILED";
    currentBatchId: string | null;
    targetLanguageTag: string;
    displayLanguageTag: string;
  retryCount: number;
  messageState: "PROCESSING" | "AVAILABLE" | "FAILED";
  messageCreatedAt: Date;
  respondsThroughMerchantVersion: number | null;
};

type ResultTransaction = {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
};

type ResultDatabase = {
  $transaction<T>(callback: (transaction: ResultTransaction) => Promise<T>): Promise<T>;
};

type ProviderFactory = (options: { provider: string; model: string }) => TranslationProvider;

function retryMinutes(): number {
  const value = Number.parseInt(process.env.TRANSLATION_BATCH_POLL_INTERVAL_MINUTES ?? "", 10);
  return Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_RETRY_MINUTES)
    : DEFAULT_RETRY_MINUTES;
}

function maxAutoRetries(): number {
  const value = Number.parseInt(process.env.TRANSLATION_MAX_AUTO_RETRIES ?? "", 10);
  return Number.isInteger(value) && value >= 0
    ? Math.min(value, MAX_AUTO_RETRIES)
    : DEFAULT_MAX_AUTO_RETRIES;
}

function resultFailureIsRetryable(failureCode: string | null): boolean {
  if (!failureCode) return true;
  const normalized = failureCode.toLowerCase();
  const httpStatus = normalized.match(/\bhttp[-_: ]?(\d{3})\b/)?.[1];
  if (httpStatus) {
    const status = Number(httpStatus);
    return status === 429 || status >= 500;
  }
  return !/(auth|permission|invalid|malformed|unsupported|content_policy|bad_request)/.test(normalized);
}

export type TranslationBatchResultsResult =
  | { status: "skipped"; batchId: string }
  | { status: "completed"; batchId: string; applied: number };

export class TranslationBatchResultsService {
  private readonly database: ResultDatabase;
  private readonly providerFactory: ProviderFactory;

  constructor(options: {
    database?: ResultDatabase;
    providerFactory?: ProviderFactory;
  } = {}) {
    this.database = options.database ?? prisma;
    this.providerFactory = options.providerFactory ?? ((providerOptions) =>
      createOpenAITranslationProvider(providerOptions));
  }

  async apply(input: { translationBatchId: string }): Promise<TranslationBatchResultsResult> {
    const batch = await this.loadBatch(input.translationBatchId);
    if (!batch || batch.status === "COMPLETED") {
      return { status: "skipped", batchId: input.translationBatchId };
    }
    if (batch.status !== "PROVIDER_COMPLETED") {
      return { status: "skipped", batchId: input.translationBatchId };
    }

    const provider = this.providerFactory({ provider: batch.provider, model: batch.model });
    const resultFileIds = [batch.outputFileId, batch.errorFileId].filter(
      (fileId): fileId is string => Boolean(fileId),
    );
    if (resultFileIds.length === 0) {
      throw new Error(`Translation Batch ${batch.id} has no provider result file`);
    }
    const resultFiles = await Promise.all(
      resultFileIds.map((fileId) => provider.readOutputFile(fileId)),
    );
    const results = resultFiles.flat();
    const expected = await this.loadExpectedItems(batch.id);
    this.validateMembership(expected, results);

    let applied = 0;
    for (const result of results) {
      const changed = await this.applyResult(batch.id, result);
      if (changed) applied += 1;
    }

    await this.completeBatch(batch.id);
    return { status: "completed", batchId: batch.id, applied };
  }

  private async loadBatch(batchId: string): Promise<ResultBatch | null> {
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<ResultBatch[]>(Prisma.sql`
        SELECT "id", "provider", "model", "status", "outputFileId", "errorFileId", "providerBatchId"
        FROM "support"."MerchantTranslationBatch"
        WHERE "id" = ${batchId}
      `);
      return rows[0] ?? null;
    });
  }

  private async loadExpectedItems(batchId: string): Promise<ExpectedItem[]> {
    return this.database.$transaction(async (transaction) => transaction.$queryRaw<ExpectedItem[]>(Prisma.sql`
      SELECT "providerCustomId", "translationId"
      FROM "support"."MerchantTranslationBatchItem"
      WHERE "batchId" = ${batchId}
    `));
  }

  private validateMembership(expected: ExpectedItem[], results: TranslationProviderResult[]): void {
    const expectedIds = new Map(expected.map((item) => [item.providerCustomId, item.translationId]));
    const seenIds = new Set<string>();
    if (results.length !== expected.length) {
      throw new Error("Translation Batch output does not contain exactly one result per expected item");
    }
    for (const result of results) {
      if (!expectedIds.has(result.providerCustomId)) {
        throw new Error(`Unknown translation Batch provider custom ID: ${result.providerCustomId}`);
      }
      if (!seenIds.add(result.providerCustomId)) {
        throw new Error("Translation Batch output contains duplicate provider custom IDs");
      }
    }
  }

  private async applyResult(batchId: string, result: TranslationProviderResult): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<TranslationRecord[]>(Prisma.sql`
        SELECT
          t."id" AS "translationId",
          t."messageId",
          m."threadId",
          m."kind",
          t."status" AS "translationStatus",
                    t."currentBatchId",
                    t."targetLanguageTag",
                    m."displayLanguageTag",
          t."retryCount",
          m."state" AS "messageState",
          m."createdAt" AS "messageCreatedAt",
          m."respondsThroughMerchantVersion"
        FROM "support"."MerchantTranslationBatchItem" i
        INNER JOIN "support"."MerchantMessageTranslation" t ON t."id" = i."translationId"
        INNER JOIN "support"."MerchantSupportMessage" m ON m."id" = t."messageId"
        WHERE i."batchId" = ${batchId}
          AND i."providerCustomId" = ${result.providerCustomId}
      `);
      const record = rows[0];
      if (!record) throw new Error(`Provider custom ID is not a member of Batch ${batchId}`);
      if (
        record.translationStatus === "AVAILABLE" ||
        record.translationStatus !== "PENDING" ||
        record.currentBatchId !== batchId
      ) return false;

      const successful = result.status === "completed" && Boolean(result.translatedText?.trim());
      if (successful) {
        const affected = await transaction.$executeRaw(Prisma.sql`
          UPDATE "support"."MerchantMessageTranslation"
          SET
            "status" = 'AVAILABLE',
            "translatedBody" = ${result.translatedText!.trim()},
            "currentBatchId" = NULL,
            "failureCode" = NULL,
            "completedAt" = NOW(),
            "updatedAt" = NOW()
          WHERE "id" = ${record.translationId}
            AND "status" = 'PENDING'
            AND "currentBatchId" = ${batchId}
        `);
        if (affected !== 1) return false;
        await markMessageAvailable(transaction, record);
        return true;
      }

      const retryable = resultFailureIsRetryable(result.failureCode);
      const retry = retryable && record.retryCount < maxAutoRetries();
      const affected = await transaction.$executeRaw(Prisma.sql`
        UPDATE "support"."MerchantMessageTranslation"
        SET
          "status" = CAST(${retry ? "PENDING" : "FAILED"} AS "support"."MerchantMessageTranslationStatus"),
          "currentBatchId" = NULL,
          "retryCount" = "retryCount" + ${retry ? 1 : 0},
          "nextAttemptAt" = ${retry ? new Date(Date.now() + retryMinutes() * 60_000) : null},
          "failureCode" = ${result.failureCode ?? "provider-result-failed"},
          "updatedAt" = NOW()
        WHERE "id" = ${record.translationId}
            AND "status" = 'PENDING'
            AND "currentBatchId" = ${batchId}
      `);
      if (affected !== 1) return false;
      if (!retry && record.kind !== "MERCHANT") {
        await transaction.$executeRaw(Prisma.sql`
          UPDATE "support"."MerchantSupportMessage"
          SET "state" = 'FAILED', "updatedAt" = NOW()
          WHERE "id" = ${record.messageId}
            AND "kind" IN ('ADMINISTRATIVE', 'SYSTEM')
            AND "state" = 'PROCESSING'
        `);
      }
      return true;
    });
  }

  private async completeBatch(batchId: string): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const pending = await transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS "count"
        FROM "support"."MerchantTranslationBatchItem" i
        INNER JOIN "support"."MerchantMessageTranslation" t ON t."id" = i."translationId"
        WHERE i."batchId" = ${batchId}
          AND t."status" NOT IN ('AVAILABLE', 'FAILED')
                AND t."currentBatchId" = ${batchId}
      `);
      if (Number(pending[0]?.count ?? 0) !== 0) {
        throw new Error(`Translation Batch ${batchId} still has unapplied items`);
      }
      await transaction.$executeRaw(Prisma.sql`
        UPDATE "support"."MerchantTranslationBatch"
        SET "status" = 'COMPLETED', "completedAt" = NOW(), "updatedAt" = NOW()
        WHERE "id" = ${batchId} AND "status" = 'PROVIDER_COMPLETED'
      `);
    });
  }
}

async function markMessageAvailable(
  transaction: ResultTransaction,
  record: TranslationRecord,
): Promise<void> {
  if (
    record.kind === "MERCHANT" ||
    record.targetLanguageTag !== record.displayLanguageTag
  ) return;
  await transaction.$executeRaw(Prisma.sql`
    UPDATE "support"."MerchantSupportMessage" m
    SET "state" = 'AVAILABLE', "availableAt" = COALESCE("availableAt", NOW()), "updatedAt" = NOW()
    WHERE m."id" = ${record.messageId}
      AND m."kind" IN ('ADMINISTRATIVE', 'SYSTEM')
      AND m."state" IN ('PROCESSING', 'FAILED')
  `);
  if (record.kind === "ADMINISTRATIVE") {
    await transaction.$executeRaw(Prisma.sql`
      UPDATE "support"."MerchantSupportThread"
      SET
        "lastAdministrativeMessageAt" = GREATEST(
          COALESCE("lastAdministrativeMessageAt", ${record.messageCreatedAt}),
          ${record.messageCreatedAt}
        ),
        "needsAdminResponse" = CASE
          WHEN "merchantMessageVersion" = ${record.respondsThroughMerchantVersion}
            THEN FALSE
          ELSE "needsAdminResponse"
        END,
        "updatedAt" = NOW()
      WHERE "id" = ${record.threadId}
    `);
  }
}

export const translationBatchResultsService = new TranslationBatchResultsService();

export const translationBatchResultsTestInternals = {
  retryMinutes,
  maxAutoRetries,
  resultFailureIsRetryable,
};
