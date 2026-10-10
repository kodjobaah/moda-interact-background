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
import { translationItemRetryDisposition } from "./translation-batch-runtime/item-retry.js";
import { applyTranslationProviderResults } from "./translation-batch-runtime/provider-results.js";
import {
  MerchantPricingTranslationRunStateService,
  type MerchantPricingTranslationRunStateTransaction,
} from "./merchant-pricing-translation/translation-run-state.service.js";
import { validateMerchantPricingTranslatedText } from "./merchant-pricing-translation/result-validation.js";

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

type ItemRecord = {
  translationItemId: string;
  sourceEntityKind: "PLAN" | "HIGHLIGHT";
  sourceField: "TITLE" | "DESCRIPTION";
  status: string;
  currentBatchId: string | null;
  retryCount: number;
};

type ResultTransaction = MerchantPricingTranslationRunStateTransaction;

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

export type MerchantPricingTranslationBatchResultsResult =
  | { status: "skipped"; batchId: string }
  | { status: "completed"; batchId: string; applied: number }
  | { status: "failed"; batchId: string; failureCode: string };

export class MerchantPricingTranslationBatchResultsService {
  private readonly database: ResultDatabase;
  private readonly providerFactory: ProviderFactory;
  private readonly runtimeConfig: TranslationRuntimeConfigReader;
  private readonly credentialResolverFactory: () => TranslationProviderCredentialResolver;
  private readonly runStateService: MerchantPricingTranslationRunStateService;

  constructor(options: {
    database?: ResultDatabase;
    providerFactory?: ProviderFactory;
    runtimeConfig?: TranslationRuntimeConfigReader;
    credentialResolverFactory?: () => TranslationProviderCredentialResolver;
    runStateService?: MerchantPricingTranslationRunStateService;
  } = {}) {
    this.database = options.database ?? prisma;
    this.providerFactory = options.providerFactory ?? ((providerOptions) =>
      createOpenAITranslationProvider(providerOptions));
    this.runtimeConfig = options.runtimeConfig ?? backgroundRuntimeConfigService;
    this.credentialResolverFactory = options.credentialResolverFactory ?? defaultCredentialResolver;
    this.runStateService = options.runStateService ?? new MerchantPricingTranslationRunStateService(this.database);
  }

  async apply(input: { translationBatchId: string }): Promise<MerchantPricingTranslationBatchResultsResult> {
    const startedAt = Date.now();
    const batch = await this.loadBatch(input.translationBatchId);
    if (!batch || batch.status !== "PROVIDER_COMPLETED") {
      return { status: "skipped", batchId: input.translationBatchId };
    }

    let provider: TranslationProvider;
    try {
      const environment = CommerceEnvironmentSchema.parse(batch.environment) as CommerceEnvironment;
      const apiKey = await this.credentialResolverFactory().resolve({
        environment,
        provider: batch.provider,
      });
      provider = this.providerFactory({ provider: batch.provider, model: batch.model, apiKey });
    } catch (error) {
      const failureCode = "invalid-provider-configuration";
      await this.failBatchItems(batch.id, batch.runId, failureCode);
      logger.error("background.merchant_pricing_translation.batch_results_failed", {
        runId: batch.runId,
        batchId: batch.id,
        provider: batch.provider,
        model: batch.model,
        failureCode,
        errorName: error instanceof Error ? error.name.slice(0, 128) : "unknown",
        durationMs: Date.now() - startedAt,
      });
      return { status: "failed", batchId: batch.id, failureCode };
    }

    try {
      const { applied } = await applyTranslationProviderResults({
        provider,
        outputFileId: batch.outputFileId,
        errorFileId: batch.errorFileId,
        missingResultFileMessage: `Merchant Pricing translation Batch ${batch.id} has no provider result file`,
        loadExpectedProviderCustomIds: async () =>
          (await this.loadExpectedItems(batch.id)).map((item) => item.providerCustomId),
        membershipMessages: {
          countMismatch: "Merchant Pricing translation Batch output does not contain exactly one result per expected item",
          unknownProviderCustomId: (providerCustomId) =>
            `Unknown Merchant Pricing translation provider custom ID: ${providerCustomId}`,
          duplicateProviderCustomId: "Merchant Pricing translation Batch output contains duplicate provider custom IDs",
        },
        applyResult: (result) => this.applyResult(batch.id, result),
      });

      await this.completeBatchAndAdvanceRun(batch.id, batch.runId);
      logger.info("background.merchant_pricing_translation.batch_completed", {
        runId: batch.runId,
        batchId: batch.id,
        applied,
        durationMs: Date.now() - startedAt,
      });
      return { status: "completed", batchId: batch.id, applied };
    } catch (error) {
      const failureCode = "provider-results-unavailable";
      await this.failBatchItems(batch.id, batch.runId, failureCode);
      logger.warn("background.merchant_pricing_translation.batch_results_failed", {
        runId: batch.runId,
        batchId: batch.id,
        provider: batch.provider,
        model: batch.model,
        failureCode,
        errorName: error instanceof Error ? error.name.slice(0, 128) : "unknown",
        durationMs: Date.now() - startedAt,
      });
      return { status: "failed", batchId: batch.id, failureCode };
    }
  }

  private async loadBatch(batchId: string): Promise<ResultBatch | null> {
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<ResultBatch[]>(Prisma.sql`
        SELECT b."id", b."runId", r."environment"::text AS "environment",
          b."provider", b."model", b."status"::text AS "status",
          b."outputFileId", b."errorFileId"
        FROM "billing"."MerchantPricingTranslationBatch" b
        INNER JOIN "billing"."MerchantPricingTranslationRun" r ON r."id" = b."runId"
        WHERE b."id" = ${batchId} AND r."status" = 'PROCESSING'
      `);
      return rows[0] ?? null;
    });
  }

  private async loadExpectedItems(batchId: string): Promise<ExpectedItem[]> {
    return this.database.$transaction(async (transaction) => transaction.$queryRaw<ExpectedItem[]>(Prisma.sql`
      SELECT "providerCustomId", "translationItemId"
      FROM "billing"."MerchantPricingTranslationBatchItem"
      WHERE "batchId" = ${batchId}
    `));
  }

  private async applyResult(batchId: string, result: TranslationProviderResult): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<ItemRecord[]>(Prisma.sql`
        SELECT t."id" AS "translationItemId", t."sourceEntityKind"::text AS "sourceEntityKind",
          t."sourceField"::text AS "sourceField", t."status"::text AS "status",
          t."currentBatchId", t."retryCount"
        FROM "billing"."MerchantPricingTranslationBatchItem" i
        INNER JOIN "billing"."MerchantPricingTranslationItem" t
          ON t."id" = i."translationItemId"
        WHERE i."batchId" = ${batchId}
          AND i."providerCustomId" = ${result.providerCustomId}
      `);
      const record = rows[0];
      if (!record) throw new Error(`Provider custom ID is not a member of Batch ${batchId}`);
      if (record.status !== "PENDING" || record.currentBatchId !== batchId) return false;

      const translatedText = result.status === "completed"
        ? validateMerchantPricingTranslatedText(record, result.translatedText)
        : null;
      if (translatedText) {
        const affected = await transaction.$executeRaw(Prisma.sql`
          UPDATE "billing"."MerchantPricingTranslationItem"
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

      const failureCode = result.status === "completed"
        ? "translation-output-validation-failed"
        : result.failureCode ?? "provider-result-failed";
      await this.applyFailureDisposition(transaction, record, batchId, failureCode);
      return false;
    });
  }

  private async failBatchItems(batchId: string, runId: string, failureCode: string): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const items = await transaction.$queryRaw<Array<Pick<ItemRecord, "translationItemId" | "retryCount">>>(Prisma.sql`
        SELECT t."id" AS "translationItemId", t."retryCount"
        FROM "billing"."MerchantPricingTranslationBatchItem" i
        INNER JOIN "billing"."MerchantPricingTranslationItem" t ON t."id" = i."translationItemId"
        WHERE i."batchId" = ${batchId}
          AND t."status" = 'PENDING'
          AND t."currentBatchId" = ${batchId}
      `);
      for (const item of items) {
        await this.applyFailureDisposition(transaction, item, batchId, failureCode);
      }
      await transaction.$executeRaw(Prisma.sql`
        UPDATE "billing"."MerchantPricingTranslationBatch"
        SET "status" = 'FAILED', "failureCode" = ${failureCode},
          "completedAt" = NOW(), "updatedAt" = NOW()
        WHERE "id" = ${batchId} AND "status" = 'PROVIDER_COMPLETED'
      `);
      await this.runStateService.advance(runId, transaction);
    });
  }

  private async applyFailureDisposition(
    transaction: ResultTransaction,
    item: Pick<ItemRecord, "translationItemId" | "retryCount">,
    batchId: string,
    failureCode: string,
  ): Promise<boolean> {
    const config = currentTranslationRuntimeConfig(this.runtimeConfig);
    const disposition = translationItemRetryDisposition({
      failureCode,
      retryCount: item.retryCount,
      maxAutoRetries: config.translationMaxAutoRetries,
      retryDelaySeconds: config.translationResultRetrySeconds,
    });
    const affected = await transaction.$executeRaw(Prisma.sql`
      UPDATE "billing"."MerchantPricingTranslationItem"
      SET
        "status" = CAST(${disposition.status} AS "billing"."MerchantPricingTranslationItemStatus"),
        "currentBatchId" = NULL,
        "retryCount" = "retryCount" + ${disposition.retryIncrement},
        "nextAttemptAt" = ${disposition.nextAttemptAt},
        "failureCode" = ${failureCode},
        "updatedAt" = NOW()
      WHERE "id" = ${item.translationItemId}
        AND "status" = 'PENDING'
        AND "currentBatchId" = ${batchId}
    `);
    return affected === 1;
  }

  private async completeBatchAndAdvanceRun(batchId: string, runId: string): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const pending = await transaction.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS "count"
        FROM "billing"."MerchantPricingTranslationBatchItem" i
        INNER JOIN "billing"."MerchantPricingTranslationItem" t ON t."id" = i."translationItemId"
        WHERE i."batchId" = ${batchId}
          AND t."status" NOT IN ('AVAILABLE', 'FAILED')
          AND t."currentBatchId" = ${batchId}
      `);
      if (Number(pending[0]?.count ?? 0) !== 0) {
        throw new Error(`Merchant Pricing translation Batch ${batchId} still has unapplied items`);
      }

      await transaction.$executeRaw(Prisma.sql`
        UPDATE "billing"."MerchantPricingTranslationBatch"
        SET "status" = 'COMPLETED', "completedAt" = NOW(), "updatedAt" = NOW()
        WHERE "id" = ${batchId} AND "status" = 'PROVIDER_COMPLETED'
      `);

      const transition = await this.runStateService.advance(runId, transaction);
      if (transition.status === "READY_TO_APPLY") {
        logger.info("background.merchant_pricing_translation.run_ready", {
          runId,
          itemCount: transition.itemCount,
        });
      }
    });
  }
}

export const merchantPricingTranslationBatchResultsService =
  new MerchantPricingTranslationBatchResultsService();
