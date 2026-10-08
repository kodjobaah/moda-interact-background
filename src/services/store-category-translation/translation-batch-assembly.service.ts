import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import prisma from "../../lib/db.js";

type BatchAssemblyDatabase = Pick<typeof prisma, "$transaction">;
type IdFactory = () => string;

export type StoreCategoryTranslationBatchAssembly = {
  batchId: string;
  itemCount: number;
  provider: string;
  model: string;
};

export class StoreCategoryTranslationBatchAssemblyService {
  constructor(
    private readonly database: BatchAssemblyDatabase = prisma,
    private readonly idFactory: IdFactory = randomUUID,
  ) {}

  async assemble(
    runId: string,
    limit: number,
  ): Promise<StoreCategoryTranslationBatchAssembly | null> {
    return this.database.$transaction(async (transaction) => {
      const runs = await transaction.$queryRaw<Array<{
        id: string;
        provider: string;
        providerModelId: string;
      }>>(Prisma.sql`
        SELECT "id", "provider", "providerModelId"
        FROM "commerce"."CommerceStoreCategoryTranslationRun"
        WHERE "id" = ${runId} AND "status" = 'PROCESSING'
        FOR UPDATE
      `);
      const run = runs[0];
      if (!run) return null;

      const candidates = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "commerce"."CommerceStoreCategoryTranslationItem"
        WHERE "runId" = ${runId}
          AND "status" = 'PENDING'
          AND "currentBatchId" IS NULL
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW())
        ORDER BY "createdAt", "id"
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      `);
      if (candidates.length === 0) return null;

      const batchId = this.idFactory();
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO "commerce"."CommerceStoreCategoryTranslationBatch" (
          "id", "runId", "provider", "model", "status", "updatedAt"
        ) VALUES (
          ${batchId}, ${runId}, ${run.provider}, ${run.providerModelId}, 'READY', NOW()
        )
      `);

      for (const candidate of candidates) {
        const providerCustomId = `store-category-${candidate.id}-${batchId}`;
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO "commerce"."CommerceStoreCategoryTranslationBatchItem" (
            "id", "batchId", "translationItemId", "providerCustomId"
          ) VALUES (
            ${this.idFactory()}, ${batchId}, ${candidate.id}, ${providerCustomId}
          )
        `);
        await transaction.$executeRaw(Prisma.sql`
          UPDATE "commerce"."CommerceStoreCategoryTranslationItem"
          SET "currentBatchId" = ${batchId}, "updatedAt" = NOW()
          WHERE "id" = ${candidate.id}
            AND "status" = 'PENDING'
            AND "currentBatchId" IS NULL
        `);
      }

      return {
        batchId,
        itemCount: candidates.length,
        provider: run.provider,
        model: run.providerModelId,
      };
    });
  }
}
