import { Prisma } from "@prisma/client";

import prisma from "../../lib/db.js";

export type StoreCategoryTranslationRunStateTransaction = {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
};

type RunStateDatabase = {
  $transaction<T>(
    callback: (transaction: StoreCategoryTranslationRunStateTransaction) => Promise<T>,
  ): Promise<T>;
};

type RunCounts = {
  total: bigint;
  available: bigint;
  failed: bigint;
  pending: bigint;
};

export type StoreCategoryTranslationRunAdvanceResult =
  | { status: "PROCESSING" }
  | { status: "FAILED"; failureCode: "TRANSLATION_ITEM_FAILED" }
  | { status: "READY_TO_PUBLISH"; localeItemCount: number };

export class StoreCategoryTranslationRunStateService {
  constructor(private readonly database: RunStateDatabase = prisma) {}

  async advance(
    runId: string,
    transaction?: StoreCategoryTranslationRunStateTransaction,
  ): Promise<StoreCategoryTranslationRunAdvanceResult> {
    if (transaction) {
      return this.advanceInTransaction(transaction, runId);
    }
    return this.database.$transaction((currentTransaction) =>
      this.advanceInTransaction(currentTransaction, runId));
  }

  private async advanceInTransaction(
    transaction: StoreCategoryTranslationRunStateTransaction,
    runId: string,
  ): Promise<StoreCategoryTranslationRunAdvanceResult> {
    const rows = await transaction.$queryRaw<RunCounts[]>(Prisma.sql`
      SELECT
        COUNT(*)::bigint AS "total",
        COUNT(*) FILTER (WHERE "status" = 'AVAILABLE')::bigint AS "available",
        COUNT(*) FILTER (WHERE "status" = 'FAILED')::bigint AS "failed",
        COUNT(*) FILTER (WHERE "status" = 'PENDING')::bigint AS "pending"
      FROM "commerce"."CommerceStoreCategoryTranslationItem"
      WHERE "runId" = ${runId}
    `);
    const count = rows[0];
    if (!count || Number(count.total) === 0) {
      return { status: "PROCESSING" };
    }

    if (Number(count.failed) > 0) {
      const changed = await transaction.$executeRaw(Prisma.sql`
        UPDATE "commerce"."CommerceStoreCategoryTranslationRun"
        SET "status" = 'FAILED', "failureCode" = 'TRANSLATION_ITEM_FAILED',
          "completedAt" = NOW(), "updatedAt" = NOW()
        WHERE "id" = ${runId} AND "status" = 'PROCESSING'
      `);
      if (changed === 1) {
        return { status: "FAILED", failureCode: "TRANSLATION_ITEM_FAILED" };
      }
      return { status: "PROCESSING" };
    }

    const localeItemCount = Number(count.total);
    if (
      Number(count.available) === localeItemCount &&
      Number(count.pending) === 0
    ) {
      const changed = await transaction.$executeRaw(Prisma.sql`
        UPDATE "commerce"."CommerceStoreCategoryTranslationRun"
        SET "status" = 'READY_TO_PUBLISH', "readyToPublishAt" = NOW(),
          "failureCode" = NULL, "updatedAt" = NOW()
        WHERE "id" = ${runId} AND "status" = 'PROCESSING'
      `);
      if (changed === 1) {
        return { status: "READY_TO_PUBLISH", localeItemCount };
      }
    }

    return { status: "PROCESSING" };
  }
}

export const storeCategoryTranslationRunStateService =
  new StoreCategoryTranslationRunStateService();
