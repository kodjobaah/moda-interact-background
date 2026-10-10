import { Prisma } from "@prisma/client";

import prisma from "../../lib/db.js";

export type MerchantPricingTranslationRunStateTransaction = {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
};

type RunStateDatabase = {
  $transaction<T>(
    callback: (transaction: MerchantPricingTranslationRunStateTransaction) => Promise<T>,
  ): Promise<T>;
};

type RunCounts = {
  total: bigint;
  available: bigint;
  failed: bigint;
  pending: bigint;
};

export type MerchantPricingTranslationRunAdvanceResult =
  | { status: "PROCESSING" }
  | { status: "FAILED"; failureCode: "TRANSLATION_ITEM_FAILED" }
  | { status: "READY_TO_APPLY"; itemCount: number };

export class MerchantPricingTranslationRunStateService {
  constructor(private readonly database: RunStateDatabase = prisma) {}

  async advance(
    runId: string,
    transaction?: MerchantPricingTranslationRunStateTransaction,
  ): Promise<MerchantPricingTranslationRunAdvanceResult> {
    if (transaction) {
      return this.advanceInTransaction(transaction, runId);
    }
    return this.database.$transaction((currentTransaction) =>
      this.advanceInTransaction(currentTransaction, runId));
  }

  private async advanceInTransaction(
    transaction: MerchantPricingTranslationRunStateTransaction,
    runId: string,
  ): Promise<MerchantPricingTranslationRunAdvanceResult> {
    const rows = await transaction.$queryRaw<RunCounts[]>(Prisma.sql`
      SELECT
        COUNT(*)::bigint AS "total",
        COUNT(*) FILTER (WHERE "status" = 'AVAILABLE')::bigint AS "available",
        COUNT(*) FILTER (WHERE "status" = 'FAILED')::bigint AS "failed",
        COUNT(*) FILTER (WHERE "status" = 'PENDING')::bigint AS "pending"
      FROM "billing"."MerchantPricingTranslationItem"
      WHERE "runId" = ${runId}
    `);
    const count = rows[0];
    if (!count || Number(count.total) === 0) {
      return { status: "PROCESSING" };
    }

    if (Number(count.failed) > 0) {
      const changed = await transaction.$executeRaw(Prisma.sql`
        UPDATE "billing"."MerchantPricingTranslationRun"
        SET "status" = 'FAILED', "failureCode" = 'TRANSLATION_ITEM_FAILED',
          "completedAt" = NOW(), "updatedAt" = NOW()
        WHERE "id" = ${runId} AND "status" = 'PROCESSING'
      `);
      if (changed === 1) {
        return { status: "FAILED", failureCode: "TRANSLATION_ITEM_FAILED" };
      }
      return { status: "PROCESSING" };
    }

    const itemCount = Number(count.total);
    if (Number(count.available) === itemCount && Number(count.pending) === 0) {
      const changed = await transaction.$executeRaw(Prisma.sql`
        UPDATE "billing"."MerchantPricingTranslationRun"
        SET "status" = 'READY_TO_APPLY', "readyToApplyAt" = NOW(),
          "failureCode" = NULL, "updatedAt" = NOW()
        WHERE "id" = ${runId} AND "status" = 'PROCESSING'
      `);
      if (changed === 1) {
        return { status: "READY_TO_APPLY", itemCount };
      }
    }

    return { status: "PROCESSING" };
  }
}

export const merchantPricingTranslationRunStateService =
  new MerchantPricingTranslationRunStateService();
