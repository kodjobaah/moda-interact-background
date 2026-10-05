import { Prisma } from "@prisma/client";
import { CommerceEnvironmentSchema, type CommerceEnvironment } from "@modainteract/moda-interact-shared/commerce/model";
import { createLogger } from "@modainteract/moda-interact-shared/logging";

import {
  createOpenAITranslationProvider,
  type TranslationProvider,
  type TranslationProviderResult,
} from "../providers/translation.provider.js";
import prisma from "../lib/db.js";
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

type ResultBatch = {
  id: string;
  runId: string;
  environment: string;
  provider: string;
  model: string;
  status: string;
  outputFileId: string | null;
  errorFileId: string | null;
};

type ExpectedItem = {
  providerCustomId: string;
  translationItemId: string;
};

type ResultTransaction = {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
};

type ResultDatabase = {
  $transaction<T>(callback: (transaction: ResultTransaction) => Promise<T>): Promise<T>;
};

type ProviderFactory = (options: { provider: string; model: string; apiKey: string }) => TranslationProvider;

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

export type StoreCategoryTranslationBatchResultsResult =
  | { status: "skipped"; batchId: string }
  | { status: "completed"; batchId: string; applied: number };

export class StoreCategoryTranslationBatchResultsService {
  private readonly database: ResultDatabase;
  private readonly providerFactory: ProviderFactory;
  private readonly runtimeConfig: TranslationRuntimeConfigReader;
  private readonly credentialResolverFactory: () => TranslationProviderCredentialResolver;

  constructor(options: {
    database?: ResultDatabase;
    providerFactory?: ProviderFactory;
    runtimeConfig?: TranslationRuntimeConfigReader;
    credentialResolverFactory?: () => TranslationProviderCredentialResolver;
  } = {}) {
    this.database = options.database ?? prisma;
    this.providerFactory = options.providerFactory ?? ((providerOptions) =>
      createOpenAITranslationProvider(providerOptions));
    this.runtimeConfig = options.runtimeConfig ?? backgroundRuntimeConfigService;
    this.credentialResolverFactory = options.credentialResolverFactory ?? defaultCredentialResolver;
  }

  async apply(input: { translationBatchId: string }): Promise<StoreCategoryTranslationBatchResultsResult> {
    const startedAt = Date.now();
    const batch = await this.loadBatch(input.translationBatchId);
    if (!batch || batch.status === "COMPLETED" || batch.status !== "PROVIDER_COMPLETED") {
      return { status: "skipped", batchId: input.translationBatchId };
    }

    const environment = CommerceEnvironmentSchema.parse(batch.environment) as CommerceEnvironment;
    const apiKey = await this.credentialResolverFactory().resolve({
      environment,
      provider: batch.provider,
    });
    const provider = this.providerFactory({ provider: batch.provider, model: batch.model, apiKey });
    const resultFileIds = [batch.outputFileId, batch.errorFileId].filter(
      (fileId): fileId is string => Boolean(fileId),
    );
    if (resultFileIds.length === 0) {
      throw new Error(`Store Category translation Batch ${batch.id} has no provider result file`);
    }

    const resultFiles = await Promise.all(resultFileIds.map((fileId) => provider.readOutputFile(fileId)));
    const results = resultFiles.flat();
    const expected = await this.loadExpectedItems(batch.id);
    this.validateMembership(expected, results);

    let applied = 0;
    for (const result of results) {
      if (await this.applyResult(batch.id, result)) applied += 1;
    }

    await this.completeBatchAndAdvanceRun(batch.id, batch.runId);
    logger.info("background.store_category_translation.batch_completed", {
      runId: batch.runId,
      batchId: batch.id,
      applied,
      durationMs: Date.now() - startedAt,
    });
    return { status: "completed", batchId: batch.id, applied };
  }

  private async loadBatch(batchId: string): Promise<ResultBatch | null> {
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<ResultBatch[]>(Prisma.sql`
        SELECT b."id", b."runId", r."environment"::text AS "environment",
          b."provider", b."model", b."status"::text AS "status",
          b."outputFileId", b."errorFileId"
        FROM "commerce"."CommerceStoreCategoryTranslationBatch" b
        INNER JOIN "commerce"."CommerceStoreCategoryTranslationRun" r ON r."id" = b."runId"
        WHERE b."id" = ${batchId} AND r."status" = 'PROCESSING'
      `);
      return rows[0] ?? null;
    });
  }

  private async loadExpectedItems(batchId: string): Promise<ExpectedItem[]> {
    return this.database.$transaction(async (transaction) => transaction.$queryRaw<ExpectedItem[]>(Prisma.sql`
      SELECT "providerCustomId", "translationItemId"
      FROM "commerce"."CommerceStoreCategoryTranslationBatchItem"
      WHERE "batchId" = ${batchId}
    `));
  }

  private validateMembership(expected: ExpectedItem[], results: TranslationProviderResult[]): void {
    const expectedIds = new Set(expected.map((item) => item.providerCustomId));
    const seenIds = new Set<string>();
    if (results.length !== expected.length) {
      throw new Error("Store Category translation Batch output does not contain exactly one result per expected item");
    }
    for (const result of results) {
      if (!expectedIds.has(result.providerCustomId)) {
        throw new Error(`Unknown Store Category translation provider custom ID: ${result.providerCustomId}`);
      }
      if (!seenIds.add(result.providerCustomId)) {
        throw new Error("Store Category translation Batch output contains duplicate provider custom IDs");
      }
    }
  }

  private async applyResult(batchId: string, result: TranslationProviderResult): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{
        translationItemId: string;
        status: string;
        currentBatchId: string | null;
        retryCount: number;
      }>>(Prisma.sql`
        SELECT t."id" AS "translationItemId", t."status"::text AS "status",
          t."currentBatchId", t."retryCount"
        FROM "commerce"."CommerceStoreCategoryTranslationBatchItem" i
        INNER JOIN "commerce"."CommerceStoreCategoryTranslationItem" t
          ON t."id" = i."translationItemId"
        WHERE i."batchId" = ${batchId}
          AND i."providerCustomId" = ${result.providerCustomId}
      `);
      const record = rows[0];
      if (!record) throw new Error(`Provider custom ID is not a member of Batch ${batchId}`);
      if (record.status !== "PENDING" || record.currentBatchId !== batchId) return false;

      const translatedText = result.translatedText?.trim();
      if (result.status === "completed" && translatedText) {
        const affected = await transaction.$executeRaw(Prisma.sql`
          UPDATE "commerce"."CommerceStoreCategoryTranslationItem"
          SET
            "status" = 'AVAILABLE',
            "translatedText" = ${translatedText},
            "currentBatchId" = NULL,
            "failureCode" = NULL,
            "nextAttemptAt" = NULL,
            "completedAt" = NOW(),
            "updatedAt" = NOW()
          WHERE "id" = ${record.translationItemId}
            AND "status" = 'PENDING'
            AND "currentBatchId" = ${batchId}
        `);
        return affected === 1;
      }

      const config = currentTranslationRuntimeConfig(this.runtimeConfig);
      const retryable = resultFailureIsRetryable(result.failureCode);
      const retry = retryable && record.retryCount < config.translationMaxAutoRetries;
      const affected = await transaction.$executeRaw(Prisma.sql`
        UPDATE "commerce"."CommerceStoreCategoryTranslationItem"
        SET
          "status" = CAST(${retry ? "PENDING" : "FAILED"} AS "commerce"."CommerceStoreCategoryTranslationItemStatus"),
          "currentBatchId" = NULL,
          "retryCount" = "retryCount" + ${retry ? 1 : 0},
          "nextAttemptAt" = ${retry ? new Date(Date.now() + config.translationResultRetrySeconds * 1000) : null},
          "failureCode" = ${result.failureCode ?? "provider-result-failed"},
          "updatedAt" = NOW()
        WHERE "id" = ${record.translationItemId}
          AND "status" = 'PENDING'
          AND "currentBatchId" = ${batchId}
      `);
      return affected === 1;
    });
  }

  private async completeBatchAndAdvanceRun(batchId: string, runId: string): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const pending = await transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS "count"
        FROM "commerce"."CommerceStoreCategoryTranslationBatchItem" i
        INNER JOIN "commerce"."CommerceStoreCategoryTranslationItem" t ON t."id" = i."translationItemId"
        WHERE i."batchId" = ${batchId}
          AND t."status" NOT IN ('AVAILABLE', 'FAILED')
          AND t."currentBatchId" = ${batchId}
      `);
      if (Number(pending[0]?.count ?? 0) !== 0) {
        throw new Error(`Store Category translation Batch ${batchId} still has unapplied items`);
      }

      await transaction.$executeRaw(Prisma.sql`
        UPDATE "commerce"."CommerceStoreCategoryTranslationBatch"
        SET "status" = 'COMPLETED', "completedAt" = NOW(), "updatedAt" = NOW()
        WHERE "id" = ${batchId} AND "status" = 'PROVIDER_COMPLETED'
      `);

      const counts = await transaction.$queryRaw<Array<{
        total: bigint;
        available: bigint;
        failed: bigint;
        pending: bigint;
      }>>(Prisma.sql`
        SELECT
          COUNT(*)::bigint AS "total",
          COUNT(*) FILTER (WHERE "status" = 'AVAILABLE')::bigint AS "available",
          COUNT(*) FILTER (WHERE "status" = 'FAILED')::bigint AS "failed",
          COUNT(*) FILTER (WHERE "status" = 'PENDING')::bigint AS "pending"
        FROM "commerce"."CommerceStoreCategoryTranslationItem"
        WHERE "runId" = ${runId}
      `);
      const count = counts[0];
      if (!count) return;
      if (Number(count.failed) > 0) {
        await transaction.$executeRaw(Prisma.sql`
          UPDATE "commerce"."CommerceStoreCategoryTranslationRun"
          SET "status" = 'FAILED', "failureCode" = 'TRANSLATION_ITEM_FAILED',
            "completedAt" = NOW(), "updatedAt" = NOW()
          WHERE "id" = ${runId} AND "status" = 'PROCESSING'
        `);
      } else if (
        Number(count.total) > 0 &&
        Number(count.available) === Number(count.total) &&
        Number(count.pending) === 0
      ) {
        const ready = await transaction.$executeRaw(Prisma.sql`
          UPDATE "commerce"."CommerceStoreCategoryTranslationRun"
          SET "status" = 'READY_TO_PUBLISH', "readyToPublishAt" = NOW(),
            "failureCode" = NULL, "updatedAt" = NOW()
          WHERE "id" = ${runId} AND "status" = 'PROCESSING'
        `);
        if (ready === 1) {
          logger.info("background.store_category_translation.run_ready_to_publish", {
            runId,
            localeItemCount: Number(count.total),
          });
        }
      }
    });
  }
}

export const storeCategoryTranslationBatchResultsService =
  new StoreCategoryTranslationBatchResultsService();

export const storeCategoryTranslationResultsTestInternals = { resultFailureIsRetryable };
