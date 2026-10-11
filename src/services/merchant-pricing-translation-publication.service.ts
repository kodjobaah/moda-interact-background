import { Prisma } from "@prisma/client";
import { createLogger } from "@modainteract/moda-interact-shared/logging";

import prisma from "../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import {
  finalizeMerchantPricingTranslationRun,
} from "./merchant-pricing-translation/publication-persistence.js";
import type {
  MerchantPricingPublicationTransaction,
  MerchantPricingTranslationPublicationOutcome,
} from "./merchant-pricing-translation/publication-types.js";

const logger = createLogger({
  serviceName: "moda-merchant-communications-worker",
  environment: resolveDeploymentEnvironmentName(),
});

type PublicationDatabase = {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
  $transaction<T>(
    callback: (transaction: MerchantPricingPublicationTransaction) => Promise<T>,
    options?: {
      isolationLevel?: Prisma.TransactionIsolationLevel;
      maxWait?: number;
      timeout?: number;
    },
  ): Promise<T>;
};

export type MerchantPricingTranslationPublicationReconciliationResult = {
  published: number;
  failuresRecorded: number;
  stale: number;
  failed: number;
  retryableFailures: number;
};

export class MerchantPricingTranslationPublicationService {
  private readonly database: PublicationDatabase;

  constructor(options: { database?: PublicationDatabase } = {}) {
    this.database = options.database ?? (prisma as unknown as PublicationDatabase);
  }

  async reconcile(
    limit: number,
  ): Promise<MerchantPricingTranslationPublicationReconciliationResult> {
    const rows = await this.database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT run."id"
      FROM "billing"."MerchantPricingTranslationRun" run
      INNER JOIN "billing"."MerchantPricingPlan" plan
        ON plan."currentTranslationRunId" = run."id"
      WHERE plan."publicationStatus" = 'TRANSLATING'
        AND run."status" IN ('READY_TO_APPLY', 'FAILED', 'STALE')
      ORDER BY COALESCE(run."readyToApplyAt", run."completedAt", run."requestedAt"), run."id"
      LIMIT ${limit}
    `);

    const result: MerchantPricingTranslationPublicationReconciliationResult = {
      published: 0,
      failuresRecorded: 0,
      stale: 0,
      failed: 0,
      retryableFailures: 0,
    };

    for (const row of rows) {
      try {
        const outcome = await this.finalize({ translationRunId: row.id });
        if (outcome.status === "published") result.published += 1;
        if (outcome.status === "failure-recorded") result.failuresRecorded += 1;
        if (outcome.status === "stale") result.stale += 1;
        if (outcome.status === "failed") result.failed += 1;
      } catch (error) {
        result.retryableFailures += 1;
        logger.error("background.merchant_pricing_translation.finalization_retryable_failure", {
          runId: row.id,
          failureCode: error instanceof Error ? error.name : "finalization-failed",
        });
      }
    }

    return result;
  }

  async finalize(input: {
    translationRunId: string;
  }): Promise<MerchantPricingTranslationPublicationOutcome> {
    const startedAt = Date.now();
    const outcome = await this.database.$transaction(
      (transaction) =>
        finalizeMerchantPricingTranslationRun(transaction, input.translationRunId),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 20_000,
      },
    );
    this.logOutcome(outcome, Date.now() - startedAt);
    return outcome;
  }

  private logOutcome(
    outcome: MerchantPricingTranslationPublicationOutcome,
    durationMs: number,
  ): void {
    if (outcome.status === "published") {
      logger.info("background.merchant_pricing_translation.draft_finalized", {
        runId: outcome.runId,
        planId: outcome.planId,
        planTranslationCount: outcome.planTranslationCount,
        highlightTranslationCount: outcome.highlightTranslationCount,
        durationMs,
      });
      return;
    }
    if (outcome.status === "failure-recorded") {
      logger.error("background.merchant_pricing_translation.draft_failure_recorded", {
        runId: outcome.runId,
        planId: outcome.planId,
        failureCode: outcome.failureCode,
        durationMs,
      });
      return;
    }
    if (outcome.status === "stale") {
      logger.warn("background.merchant_pricing_translation.draft_stale", {
        runId: outcome.runId,
        planId: outcome.planId,
        failureCode: outcome.failureCode,
        durationMs,
      });
      return;
    }
    if (outcome.status === "failed") {
      logger.error("background.merchant_pricing_translation.draft_finalization_failed", {
        runId: outcome.runId,
        planId: outcome.planId,
        failureCode: outcome.failureCode,
        durationMs,
      });
    }
  }
}

export const merchantPricingTranslationPublicationService =
  new MerchantPricingTranslationPublicationService();
