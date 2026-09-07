import "dotenv/config";

import { randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  TranslationBatchSubmissionError,
  TranslationBatchSubmitService,
} from "../../src/services/translation-batch-submit.service.js";
import { TranslationBatchPollService } from "../../src/services/translation-batch-poll.service.js";
import { TranslationBatchResultsService } from "../../src/services/translation-batch-results.service.js";
import { TranslationReconciliationService } from "../../src/services/translation-reconciliation.service.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

type Fixture = {
  shopId: string;
  batchId: string;
  translationId?: string;
};

async function seedBatch(
  database: PrismaClient,
  status: "READY" | "SUBMITTED" | "PROVIDER_COMPLETED" | "SUBMISSION_UNKNOWN",
  options: { withTranslation?: boolean } = {},
): Promise<Fixture> {
  const shopId = randomUUID();
  const threadId = randomUUID();
  const messageId = randomUUID();
  const translationId = randomUUID();
  const batchId = randomUUID();
  const itemId = randomUUID();
  const statusLiteral = {
    READY: Prisma.sql`'READY'`,
    SUBMITTED: Prisma.sql`'SUBMITTED'`,
    PROVIDER_COMPLETED: Prisma.sql`'PROVIDER_COMPLETED'`,
    SUBMISSION_UNKNOWN: Prisma.sql`'SUBMISSION_UNKNOWN'`,
  }[status];

  await database.$executeRaw(Prisma.sql`
    INSERT INTO "commerce"."Shop" ("id", "domain", "status", "updatedAt")
    VALUES (${shopId}, ${`${shopId}.test`}, 'ACTIVE', NOW())
  `);
  await database.$executeRaw(Prisma.sql`
    INSERT INTO "support"."MerchantSupportThread" ("id", "shopId", "updatedAt")
    VALUES (${threadId}, ${shopId}, NOW())
  `);
  await database.$executeRaw(Prisma.sql`
    INSERT INTO "support"."MerchantSupportMessage" (
      "id", "threadId", "kind", "state", "originalBody", "sourceLanguageTag", "displayLanguageTag", "updatedAt"
    ) VALUES (
      ${messageId}, ${threadId}, 'MERCHANT', 'AVAILABLE', 'Bonjour', 'fr-FR', 'en-GB', NOW()
    )
  `);
  await database.$executeRaw(Prisma.sql`
    INSERT INTO "support"."MerchantTranslationBatch" (
      "id", "provider", "model", "status", "providerBatchId", "inputFileId", "outputFileId", "pollSequence", "updatedAt"
    ) VALUES (
      ${batchId}, 'openai', 'integration-test-model', ${statusLiteral},
      ${status === "SUBMITTED" ? "provider-batch" : null},
      ${status === "SUBMISSION_UNKNOWN" ? "input-file" : null},
      ${status === "PROVIDER_COMPLETED" ? "output-file" : null},
      1, NOW()
    )
  `);

  if (!options.withTranslation) return { shopId, batchId };

  await database.$executeRaw(Prisma.sql`
    INSERT INTO "support"."MerchantMessageTranslation" (
      "id", "messageId", "direction", "sourceLanguageTag", "targetLanguageTag", "status", "currentBatchId", "updatedAt"
    ) VALUES (
      ${translationId}, ${messageId}, 'MERCHANT_TO_ADMIN', 'fr-FR', 'en-GB', 'PENDING', ${batchId}, NOW()
    )
  `);
  await database.$executeRaw(Prisma.sql`
    INSERT INTO "support"."MerchantTranslationBatchItem" (
      "id", "batchId", "translationId", "providerCustomId"
    ) VALUES (${itemId}, ${batchId}, ${translationId}, ${`custom-${translationId}`})
  `);

  return { shopId, batchId, translationId };
}

async function readStatus(database: PrismaClient, table: string, id: string): Promise<string> {
  const rows = await database.$queryRaw<Array<{ status: string }>>(
    Prisma.sql`SELECT "status"::text AS "status" FROM ${Prisma.raw(table)} WHERE "id" = ${id}`,
  );
  return rows[0]!.status;
}

async function cleanup(database: PrismaClient, fixture: Fixture): Promise<void> {
  await database.$executeRaw(Prisma.sql`
    DELETE FROM "support"."MerchantTranslationBatch" WHERE "id" = ${fixture.batchId}
  `);
  await database.$executeRaw(Prisma.sql`
    DELETE FROM "commerce"."Shop" WHERE "id" = ${fixture.shopId}
  `);
}

describeWithDatabase("translation enum bindings PostgreSQL regression", () => {
  it("persists submission failure statuses through the real enum column", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const database = new PrismaClient();
    const fixture = await seedBatch(database, "READY");
    try {
      const service = new TranslationBatchSubmitService({
        database,
        provider: {
          prepareBatchInput: async () => {
            throw new TranslationBatchSubmissionError("DEFINITE_TERMINAL_NOT_CREATED", "provider rejected input");
          },
        } as never,
        queue: { add: async () => undefined },
      });

      await service.submit({ translationBatchId: fixture.batchId });
      expect(await readStatus(database, '"support"."MerchantTranslationBatch"', fixture.batchId)).toBe("FAILED");
    } finally {
      await cleanup(database, fixture);
      await database.$disconnect();
    }
  }, 30_000);

  it("persists terminal poll Batch and translation statuses through real enum columns", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.TRANSLATION_MAX_AUTO_RETRIES = "0";
    const database = new PrismaClient();
    const fixture = await seedBatch(database, "SUBMITTED", { withTranslation: true });
    try {
      const service = new TranslationBatchPollService({
        database,
        providerFactory: () => ({
          retrieveBatch: async () => ({
            provider: "openai" as const,
            providerBatchId: "provider-batch",
            logicalBatchId: fixture.batchId,
            status: "failed" as const,
            inputFileId: null,
            outputFileId: null,
            errorFileId: null,
            failureCode: "invalid_request",
            createdAt: null,
            completedAt: null,
          }),
        }) as never,
        queue: { add: async () => undefined },
      });

      await service.poll({ schemaVersion: 1, translationBatchId: fixture.batchId, pollSequence: 1 });
      expect(await readStatus(database, '"support"."MerchantTranslationBatch"', fixture.batchId)).toBe("FAILED");
      expect(await readStatus(database, '"support"."MerchantMessageTranslation"', fixture.translationId!)).toBe("FAILED");
    } finally {
      await cleanup(database, fixture);
      await database.$disconnect();
    }
  }, 30_000);

  it("persists failed provider results through the real translation enum column", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.TRANSLATION_MAX_AUTO_RETRIES = "0";
    const database = new PrismaClient();
    const fixture = await seedBatch(database, "PROVIDER_COMPLETED", { withTranslation: true });
    try {
      const service = new TranslationBatchResultsService({
        database,
        providerFactory: () => ({
          readOutputFile: async () => [{
            providerCustomId: `custom-${fixture.translationId}`,
            status: "failed" as const,
            translatedText: null,
            failureCode: "invalid_request",
          }],
        }) as never,
      });

      await service.apply({ translationBatchId: fixture.batchId });
      expect(await readStatus(database, '"support"."MerchantMessageTranslation"', fixture.translationId!)).toBe("FAILED");
    } finally {
      await cleanup(database, fixture);
      await database.$disconnect();
    }
  }, 30_000);

  it("persists SUBMISSION_UNKNOWN correlation adoption through the real Batch enum column", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const database = new PrismaClient();
    const fixture = await seedBatch(database, "SUBMISSION_UNKNOWN");
    try {
      const service = new TranslationReconciliationService({
        database,
        queue: {
          getJob: async () => undefined,
          add: async () => undefined,
        },
        providerFactory: () => ({
          findBatchByCorrelation: async () => ({
            kind: "match" as const,
            batch: {
              provider: "openai" as const,
              providerBatchId: "provider-recovered",
              logicalBatchId: fixture.batchId,
              status: "completed" as const,
              inputFileId: "input-file",
              outputFileId: "output-file",
              errorFileId: null,
              failureCode: null,
              createdAt: null,
              completedAt: null,
            },
          }),
        }) as never,
      });

      await service.reconcile();
      expect(await readStatus(database, '"support"."MerchantTranslationBatch"', fixture.batchId)).toBe("PROVIDER_COMPLETED");
    } finally {
      await cleanup(database, fixture);
      await database.$disconnect();
    }
  }, 30_000);
});
