import "dotenv/config";

import { randomBytes, randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { TranslationBatchAssemblyService } from "../../src/services/translation-batch-assembly.service.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase =
  testDatabaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
    ? describe
    : describe.skip;

describeWithDatabase(
  "translation batch assembly PostgreSQL concurrency",
  () => {
    it("assigns concurrent candidates to disjoint current batches with SKIP LOCKED", async () => {
      process.env.DATABASE_URL = testDatabaseUrl;

      const database = new PrismaClient();
      const shopId = randomUUID();
      const threadId = randomUUID();
      const messageIds = [randomUUID(), randomUUID()];
      const translationIds = [randomUUID(), randomUUID()];
      const batchIds: string[] = [];
      const actorId = randomUUID();
      let modelId: string | undefined;
      let providerCredentialId: string | undefined;

      try {
        await database.platformAdmin.create({ data: { id: actorId, email: `${actorId}@example.test` } });
        const credential = await database.commerceTranslationProviderCredential.create({
          data: { environment: "TEST", provider: "openai", updatedByAdminId: actorId,
            ciphertext: randomBytes(32), nonce: randomBytes(12), authTag: randomBytes(16), keyId: "integration-test" },
        });
        providerCredentialId = credential.id;
        const automaticModel = await database.commerceTranslationModelConfiguration.create({
          data: { environment: "TEST", provider: "openai", providerModelId: "integration-test-model",
            displayName: "Integration test model", enabled: true, automaticDefault: true,
            createdByAdminId: actorId, updatedByAdminId: actorId },
        });
        modelId = automaticModel.id;
        await database.$executeRaw(Prisma.sql`
INSERT INTO "commerce"."Shop" (
  "id",
  "domain",
  "status",
  "updatedAt"
)
VALUES (
  ${shopId},
  ${`${shopId}.test`},
  'ACTIVE',
  NOW()
)
          `);
        await database.$executeRaw(Prisma.sql`
INSERT INTO "support"."MerchantSupportThread" (
  "id",
  "shopId",
  "updatedAt"
)
VALUES (
  ${threadId},
  ${shopId},
  NOW()
)
          `);

        for (const [index, messageId] of messageIds.entries()) {
          const translationId = translationIds[index]!;
          const originalBody = `Bonjour ${index + 1}`;

          await database.$executeRaw(Prisma.sql`
    INSERT INTO "support"."MerchantSupportMessage" (
      "id",
      "threadId",
      "kind",
      "state",
      "originalBody",
      "sourceLanguageTag",
      "updatedAt"
    )
    VALUES (
      ${messageId},
      ${threadId},
      'MERCHANT',
      'AVAILABLE',
      ${originalBody},
      'fr-FR',
      NOW()
    )
  `);

          await database.$executeRaw(Prisma.sql`
    INSERT INTO "support"."MerchantMessageTranslation" (
      "id",
      "messageId",
      "direction",
      "sourceLanguageTag",
      "targetLanguageTag",
      "status",
      "updatedAt"
    )
    VALUES (
      ${translationId},
      ${messageId},
      'MERCHANT_TO_ADMIN',
      'fr-FR',
      'en-GB',
      'PENDING',
      NOW()
    )
  `);
        }

        const createService = () =>
          new TranslationBatchAssemblyService({
            database,
            runtimeConfig: { current: () => ({ translationBatchMaxRequests: 1 }) } as any,
            queue: { add: async () => undefined },
          });

        const results = await Promise.all([
          createService().assembleFromDispatch({
            schemaVersion: 1,
            translationId: translationIds[0],
          }),
          createService().assembleFromDispatch({
            schemaVersion: 1,
            translationId: translationIds[1],
          }),
        ]);

        batchIds.push(
          ...results.flatMap((result) =>
            result.batchId ? [result.batchId] : [],
          ),
        );
        expect(batchIds).toHaveLength(2);
        expect(new Set(batchIds).size).toBe(2);

        const assignments = await database.$queryRaw<
          Array<{
            id: string;
            currentBatchId: string | null;
            itemCount: bigint;
          }>
        >(Prisma.sql`
            SELECT
              t."id",
              t."currentBatchId",
              COUNT(i."id") AS "itemCount"
            FROM "support"."MerchantMessageTranslation" t
            LEFT JOIN "support"."MerchantTranslationBatchItem" i
              ON i."translationId" = t."id"
            WHERE t."id" IN (${Prisma.join(translationIds)})
            GROUP BY t."id", t."currentBatchId"
            ORDER BY t."id"
          `);

        expect(assignments).toHaveLength(2);
        expect(assignments.every((row) => row.currentBatchId)).toBe(true);
        expect(assignments.every((row) => row.itemCount === 1n)).toBe(true);
        expect(new Set(assignments.map((row) => row.currentBatchId)).size).toBe(
          2,
        );
      } finally {
        if (batchIds.length > 0) {
          await database.$executeRaw(Prisma.sql`
              DELETE FROM "support"."MerchantTranslationBatch"
              WHERE "id" IN (${Prisma.join(batchIds)})
            `);
        }
        await database.$executeRaw(
          Prisma.sql`DELETE FROM "commerce"."Shop" WHERE "id" = ${shopId}`,
        );
        if (modelId) await database.commerceTranslationModelConfiguration.delete({ where: { id: modelId } });
        if (providerCredentialId) await database.commerceTranslationProviderCredential.delete({ where: { id: providerCredentialId } });
        await database.platformAdmin.deleteMany({ where: { id: actorId } });
        await database.$disconnect();
      }
    }, 30_000);
  },
);
