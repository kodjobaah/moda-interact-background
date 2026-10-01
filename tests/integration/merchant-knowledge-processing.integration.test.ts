import "dotenv/config";

import { createHash, randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { MerchantKnowledgeEntitlementService } from "../../src/services/merchant-knowledge-entitlement.service.js";
import { MerchantKnowledgeProcessingService } from "../../src/services/merchant-knowledge-processing.service.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl
  && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe
  : describe.skip;

describeWithDatabase("Merchant Knowledge processing pgvector promotion", () => {
  it("persists candidate vectors and supersedes the predecessor transactionally", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const database = new PrismaClient();
    const shopId = randomUUID();
    const planId = randomUUID();
    const sourceId = randomUUID();
    const predecessorId = randomUUID();
    const candidateId = randomUUID();
    const planHandle = `merchant-knowledge-${randomUUID()}`;
    let featureId: string | undefined;
    let createdFeature = false;

    try {
      const [purpose, dataFormat] = await Promise.all([
        database.merchantKnowledgePurpose.findUniqueOrThrow({
          where: { key: "COMPANY_INFORMATION" },
          select: { id: true },
        }),
        database.merchantKnowledgeDataFormat.findUniqueOrThrow({
          where: { key: "WEB_PAGE" },
          select: { id: true },
        }),
      ]);
      const existingFeature = await database.feature.findUnique({
        where: { key: "merchant_knowledge" },
        select: { id: true, active: true, activationMode: true },
      });
      if (
        existingFeature
        && (!existingFeature.active || existingFeature.activationMode !== "MERCHANT_OPT_IN")
      ) {
        throw new Error("merchant_knowledge Feature must be active and MERCHANT_OPT_IN");
      }
      featureId = existingFeature?.id ?? randomUUID();

      await database.shop.create({ data: { id: shopId, domain: `${shopId}.test` } });
      if (!existingFeature) {
        await database.feature.create({
          data: {
            id: featureId,
            key: "merchant_knowledge",
            displayName: "Merchant Knowledge processing fixture",
            activationMode: "MERCHANT_OPT_IN",
          },
        });
        createdFeature = true;
      }
      await database.billingPlan.create({
        data: {
          id: planId,
          shopifyPlanHandle: planHandle,
          name: "Merchant Knowledge processing fixture",
          kind: "FREE",
        },
      });
      await database.billingPlanFeature.create({
        data: {
          planId,
          featureId,
          enabled: true,
          configuration: {
            schemaVersion: 1,
            maxKnowledgeSources: 1,
            maxContentUnitsPerSource: 100,
            allowedSourceTypes: [
              { purposeKey: "COMPANY_INFORMATION", dataFormatKey: "WEB_PAGE" },
            ],
          },
        },
      });
      await database.subscription.create({ data: { shopId, planId, status: "ACTIVE" } });
      await database.shopFeaturePreference.create({
        data: { shopId, featureId, enabled: true },
      });
      await database.merchantKnowledgeSource.create({
        data: {
          id: sourceId,
          shopId,
          purposeId: purpose.id,
          dataFormatId: dataFormat.id,
          name: "Fixture source",
          languageTag: "en",
          position: 0,
          currentGeneration: 2,
        },
      });
      const predecessorCompletedAt = new Date("2026-09-30T12:00:00.000Z");
      await database.merchantKnowledgeSourceRevision.create({
        data: {
          id: predecessorId,
          sourceId,
          generation: 1,
          reason: "CREATE",
          requestedUrl: "https://merchant.example/old",
          status: "ACTIVE",
          normalizedContent: "retained old content",
          contentUnits: 5,
          contentHash: "a".repeat(64),
          completedAt: predecessorCompletedAt,
        },
      });
      await database.merchantKnowledgeSourceRevision.create({
        data: {
          id: candidateId,
          sourceId,
          generation: 2,
          reason: "URL_CHANGE",
          requestedUrl: "https://merchant.example/new",
          status: "PROCESSING",
        },
      });
      await database.$executeRaw(Prisma.sql`
        INSERT INTO "commerce"."MerchantKnowledgeChunk"
          ("id", "revisionId", "ordinal", "content", "contentUnits", "contentHash",
           "embedding", "embeddingProvider", "embeddingModel", "embeddingDimensions", "embeddingIndexVersion")
        VALUES
          (${randomUUID()}, ${predecessorId}, 0, ${"old chunk"}, 3, ${"b".repeat(64)},
           ${"[0.5,0.5]"}::vector, ${"openai"}, ${"test-model"}, ${2}, ${"v1"})
      `);

      const text = "Current merchant knowledge";
      const service = new MerchantKnowledgeProcessingService({
        database,
        eligibility: new MerchantKnowledgeEntitlementService(database),
        webPageAcquirer: {
          acquire: vi.fn(async () => ({
            contentType: "text/html",
            extractedText: text,
            resolvedUrl: "https://merchant.example/new",
            fetchedAt: new Date("2026-10-01T00:00:00.000Z"),
          })),
        },
        uploadedAssetAcquirer: {
          acquire: vi.fn(async () => {
            throw new Error("unexpected upload acquisition");
          }),
        },
        embedding: {
          config: {
            provider: "openai",
            model: "test-model",
            dimensions: 2,
            indexVersion: "v1",
          },
          embed: vi.fn(async () => [0.25, 0.75]),
        } as never,
      });

      await service.processJob({
        schemaVersion: 1,
        shopId,
        sourceRevisionId: candidateId,
        generation: 2,
        requestedAt: "2026-10-01T00:00:00.000Z",
      });

      await expect(
        database.merchantKnowledgeSourceRevision.findUniqueOrThrow({
          where: { id: candidateId },
          select: { status: true, normalizedContent: true, contentUnits: true, contentHash: true },
        }),
      ).resolves.toEqual({
        status: "ACTIVE",
        normalizedContent: text,
        contentUnits: 7,
        contentHash: createHash("sha256").update(text, "utf8").digest("hex"),
      });
      await expect(
        database.merchantKnowledgeSourceRevision.findUniqueOrThrow({
          where: { id: predecessorId },
          select: { status: true, normalizedContent: true, completedAt: true },
        }),
      ).resolves.toEqual({
        status: "SUPERSEDED",
        normalizedContent: "retained old content",
        completedAt: predecessorCompletedAt,
      });
      await expect(
        database.merchantKnowledgeChunk.count({ where: { revisionId: predecessorId } }),
      ).resolves.toBe(0);
      const chunks = await database.$queryRaw<Array<{
        content: string;
        embedding: string;
        embeddingProvider: string;
        embeddingModel: string;
        embeddingDimensions: number;
        embeddingIndexVersion: string;
      }>>(Prisma.sql`
        SELECT "content", "embedding"::text AS "embedding", "embeddingProvider",
               "embeddingModel", "embeddingDimensions", "embeddingIndexVersion"
        FROM "commerce"."MerchantKnowledgeChunk"
        WHERE "revisionId" = ${candidateId}
      `);
      expect(chunks).toEqual([{
        content: text,
        embedding: "[0.25,0.75]",
        embeddingProvider: "openai",
        embeddingModel: "test-model",
        embeddingDimensions: 2,
        embeddingIndexVersion: "v1",
      }]);
    } finally {
      await database.merchantKnowledgeSourceRevision.deleteMany({ where: { sourceId } });
      await database.merchantKnowledgeSource.deleteMany({ where: { id: sourceId } });
      if (featureId) {
        await database.shopFeaturePreference.deleteMany({ where: { shopId, featureId } });
      }
      await database.subscription.deleteMany({ where: { shopId } });
      await database.billingPlanFeature.deleteMany({ where: { planId } });
      await database.shop.deleteMany({ where: { id: shopId } });
      await database.billingPlan.deleteMany({ where: { id: planId } });
      if (createdFeature && featureId) {
        await database.feature.deleteMany({ where: { id: featureId } });
      }
      await database.$disconnect();
    }
  }, 30_000);
});