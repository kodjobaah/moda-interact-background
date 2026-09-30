import "dotenv/config";

import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { MerchantKnowledgeReconciliationService } from "../../src/services/merchant-knowledge-reconciliation.service.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl
  && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe
  : describe.skip;

describeWithDatabase("Merchant Knowledge pending-revision reconciliation PostgreSQL", () => {
  it("recovers a committed PENDING revision after enqueue loss with a stable job ID", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const database = new PrismaClient();
    const shopId = randomUUID();
    let featureId: string | undefined;
    let createdFeature = false;
    const planId = randomUUID();
    const sourceId = randomUUID();
    const revisionId = randomUUID();
    const planHandle = `arch023-${randomUUID()}`;
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
        select: { id: true, active: true },
      });
      if (existingFeature && !existingFeature.active) {
        throw new Error("merchant_knowledge Feature must be active for this integration test");
      }
      featureId = existingFeature?.id ?? randomUUID();

      await database.shop.create({
        data: { id: shopId, domain: `${shopId}.test` },
      });
      if (!existingFeature) {
        await database.feature.create({
          data: {
            id: featureId,
            key: "merchant_knowledge",
            displayName: "Merchant Knowledge integration fixture",
            activationMode: "ALWAYS_ENABLED",
          },
        });
        createdFeature = true;
      }
      await database.billingPlan.create({
        data: {
          id: planId,
          shopifyPlanHandle: planHandle,
          name: "Merchant Knowledge integration fixture",
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
            maxContentUnitsPerSource: 8_000,
            allowedSourceTypes: [
              { purposeKey: "COMPANY_INFORMATION", dataFormatKey: "WEB_PAGE" },
            ],
          },
        },
      });
      await database.subscription.create({
        data: { shopId, planId, status: "ACTIVE" },
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
          currentGeneration: 1,
        },
      });
      await database.merchantKnowledgeSourceRevision.create({
        data: {
          id: revisionId,
          sourceId,
          generation: 1,
          reason: "CREATE",
          requestedUrl: "https://example.invalid/merchant-knowledge",
          status: "PENDING",
          requestedAt: new Date("2026-09-30T10:00:00.000Z"),
        },
      });

      const lostQueue = { add: vi.fn().mockRejectedValueOnce(new Error("simulated enqueue loss")) };
      const failedPublication = new MerchantKnowledgeReconciliationService(
        database,
        lostQueue as never,
      );
      await expect(failedPublication.reconcilePendingOnce()).rejects.toThrow("simulated enqueue loss");
      await expect(
        database.merchantKnowledgeSourceRevision.findUniqueOrThrow({
          where: { id: revisionId },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: "PENDING" });

      const recoveredQueue = { add: vi.fn().mockResolvedValue(undefined) };
      const recovery = new MerchantKnowledgeReconciliationService(
        database,
        recoveredQueue as never,
      );
      await expect(recovery.reconcilePendingOnce()).resolves.toMatchObject({
        scanned: 1,
        enqueued: 1,
        skippedStale: 0,
        skippedDormant: 0,
      });
      const firstJobId = recoveredQueue.add.mock.calls[0]?.[2].jobId;
      await recovery.reconcilePendingOnce();
      expect(recoveredQueue.add.mock.calls[1]?.[2].jobId).toBe(firstJobId);
    } finally {
      await database.merchantKnowledgeSourceRevision.deleteMany({ where: { id: revisionId } });
      await database.merchantKnowledgeSource.deleteMany({ where: { id: sourceId } });
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