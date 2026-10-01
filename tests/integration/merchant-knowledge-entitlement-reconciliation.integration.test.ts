import "dotenv/config";

import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createMerchantKnowledgeProcessJobId } from "@modainteract/moda-interact-shared/merchant-knowledge/node";

import { MerchantKnowledgeEntitlementReconciliationService } from "../../src/services/merchant-knowledge-entitlement-reconciliation.service.js";
import { MerchantKnowledgeEntitlementService } from "../../src/services/merchant-knowledge-entitlement.service.js";
import { MerchantKnowledgeReconciliationService } from "../../src/services/merchant-knowledge-reconciliation.service.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = testDatabaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe
  : describe.skip;

interface Fixture {
  shopId: string;
  featureId: string;
  createdFeature: boolean;
  planIds: string[];
  sourceIds: string[];
  assetIds: string[];
  createdMappings: Array<{ purposeId: string; dataFormatId: string }>;
}

interface FixtureOptions {
  dataFormatKey?: "WEB_PAGE" | "CSV" | "XLSX";
  purposeKey?: "COMPANY_INFORMATION" | "PRODUCT_INFORMATION" | "FAQ";
  position?: number;
  contentUnits?: number;
  maxContentUnitsPerSource?: number;
  maxKnowledgeSources?: number;
  allowedSourceTypes?: Array<{ purposeKey: string; dataFormatKey: string }>;
  pendingPlanMaxContentUnits?: number;
}

async function createFixture(database: PrismaClient, options: FixtureOptions = {}): Promise<Fixture> {
  const shopId = randomUUID();
  const planId = randomUUID();
  const feature = await database.feature.findUnique({
    where: { key: "merchant_knowledge" },
    select: { id: true, active: true, activationMode: true },
  });
  if (feature && (!feature.active || feature.activationMode !== "MERCHANT_OPT_IN")) {
    throw new Error("merchant_knowledge Feature must be active and MERCHANT_OPT_IN for this integration test");
  }
  const featureId = feature?.id ?? randomUUID();
  const fixture: Fixture = {
    shopId,
    featureId,
    createdFeature: !feature,
    planIds: [planId],
    sourceIds: [],
    assetIds: [],
    createdMappings: [],
  };

  await database.shop.create({ data: { id: shopId, domain: `${shopId}.test` } });
  if (!feature) {
    await database.feature.create({
      data: {
        id: featureId,
        key: "merchant_knowledge",
        displayName: "Merchant Knowledge entitlement fixture",
        activationMode: "MERCHANT_OPT_IN",
      },
    });
  }
  const planData = async (id: string, suffix: string) => database.billingPlan.create({
    data: {
      id,
      shopifyPlanHandle: `merchant-knowledge-${shopId}-${suffix}`,
      name: `Merchant Knowledge ${suffix} fixture`,
      kind: "FREE",
    },
  });
  await planData(planId, "current");
  await database.billingPlanFeature.create({
    data: {
      planId,
      featureId,
      enabled: true,
      configuration: {
        schemaVersion: 1,
        maxKnowledgeSources: options.maxKnowledgeSources ?? 2,
        maxContentUnitsPerSource: options.maxContentUnitsPerSource ?? 10,
        allowedSourceTypes: options.allowedSourceTypes ?? [{
          purposeKey: options.purposeKey ?? "COMPANY_INFORMATION",
          dataFormatKey: options.dataFormatKey ?? "WEB_PAGE",
        }],
      },
    },
  });

  let pendingPlanId: string | undefined;
  if (options.pendingPlanMaxContentUnits !== undefined) {
    pendingPlanId = randomUUID();
    fixture.planIds.push(pendingPlanId);
    await planData(pendingPlanId, "pending");
    await database.billingPlanFeature.create({
      data: {
        planId: pendingPlanId,
        featureId,
        enabled: true,
        configuration: {
          schemaVersion: 1,
          maxKnowledgeSources: options.maxKnowledgeSources ?? 2,
          maxContentUnitsPerSource: options.pendingPlanMaxContentUnits,
          allowedSourceTypes: options.allowedSourceTypes ?? [{
            purposeKey: options.purposeKey ?? "COMPANY_INFORMATION",
            dataFormatKey: options.dataFormatKey ?? "WEB_PAGE",
          }],
        },
      },
    });
  }

  await database.subscription.create({
    data: {
      shopId,
      planId,
      pendingPlanId,
      status: "ACTIVE",
    },
  });
  await database.shopFeaturePreference.create({
    data: { shopId, featureId, enabled: true },
  });

  return fixture;
}

async function addSource(
  database: PrismaClient,
  fixture: Fixture,
  options: FixtureOptions = {},
): Promise<{ sourceId: string; revisionId: string; assetId: string | null }> {
  const purposeKey = options.purposeKey ?? "COMPANY_INFORMATION";
  const dataFormatKey = options.dataFormatKey ?? "WEB_PAGE";
  const [purpose, dataFormat] = await Promise.all([
    database.merchantKnowledgePurpose.findUniqueOrThrow({
      where: { key: purposeKey },
      select: { id: true },
    }),
    database.merchantKnowledgeDataFormat.findUniqueOrThrow({
      where: { key: dataFormatKey },
      select: { id: true },
    }),
  ]);
  const mapping = await database.merchantKnowledgePurposeDataFormat.findUnique({
    where: { purposeId_dataFormatId: { purposeId: purpose.id, dataFormatId: dataFormat.id } },
    select: { purposeId: true },
  });
  if (!mapping) {
    await database.merchantKnowledgePurposeDataFormat.create({
      data: { purposeId: purpose.id, dataFormatId: dataFormat.id },
    });
    fixture.createdMappings.push({ purposeId: purpose.id, dataFormatId: dataFormat.id });
  }

  const sourceId = randomUUID();
  const revisionId = randomUUID();
  const position = options.position ?? fixture.sourceIds.length;
  await database.merchantKnowledgeSource.create({
    data: {
      id: sourceId,
      shopId: fixture.shopId,
      purposeId: purpose.id,
      dataFormatId: dataFormat.id,
      name: `Fixture source ${position}`,
      languageTag: "en",
      position,
      currentGeneration: 1,
    },
  });

  let assetId: string | null = null;
  if (dataFormatKey === "CSV" || dataFormatKey === "XLSX") {
    assetId = randomUUID();
    fixture.assetIds.push(assetId);
    const extension = dataFormatKey === "CSV" ? "csv" : "xlsx";
    await database.merchantKnowledgeUploadedAsset.create({
      data: {
        id: assetId,
        shopId: fixture.shopId,
        dataFormatId: dataFormat.id,
        status: "AVAILABLE",
        objectKey: `${fixture.shopId}/${assetId}.${extension}`,
        originalFileName: `fixture.${extension}`,
        contentType: dataFormatKey === "CSV" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 1n,
        sha256: "a".repeat(64),
        uploadExpiresAt: new Date("2026-10-02T00:00:00.000Z"),
        availableAt: new Date("2026-10-01T00:00:00.000Z"),
      },
    });
  }

  await database.merchantKnowledgeSourceRevision.create({
    data: {
      id: revisionId,
      sourceId,
      uploadedAssetId: assetId,
      generation: 1,
      reason: "CREATE",
      requestedUrl: dataFormatKey === "WEB_PAGE" ? "https://merchant.example/knowledge" : null,
      status: "ACTIVE",
      normalizedContent: "retained normalized content",
      contentUnits: options.contentUnits ?? 15,
      contentHash: "b".repeat(64),
      completedAt: new Date("2026-09-30T00:00:00.000Z"),
    },
  });
  fixture.sourceIds.push(sourceId);
  return { sourceId, revisionId, assetId };
}

async function removeFixture(database: PrismaClient, fixture: Fixture): Promise<void> {
  await database.merchantKnowledgeSourceRevision.deleteMany({
    where: { sourceId: { in: fixture.sourceIds } },
  });
  await database.merchantKnowledgeSource.deleteMany({ where: { id: { in: fixture.sourceIds } } });
  await database.merchantKnowledgeUploadedAsset.deleteMany({ where: { id: { in: fixture.assetIds } } });
  await database.shopFeaturePreference.deleteMany({ where: { shopId: fixture.shopId, featureId: fixture.featureId } });
  await database.subscription.deleteMany({ where: { shopId: fixture.shopId } });
  await database.billingPlanFeature.deleteMany({ where: { planId: { in: fixture.planIds } } });
  await database.billingPlan.deleteMany({ where: { id: { in: fixture.planIds } } });
  await database.shop.deleteMany({ where: { id: fixture.shopId } });
  for (const mapping of fixture.createdMappings) {
    await database.merchantKnowledgePurposeDataFormat.deleteMany({
      where: { purposeId: mapping.purposeId, dataFormatId: mapping.dataFormatId },
    });
  }
  if (fixture.createdFeature) {
    await database.feature.deleteMany({ where: { id: fixture.featureId } });
  }
}

function reconciliationService(
  database: PrismaClient,
  queue: { add: ReturnType<typeof vi.fn> },
): MerchantKnowledgeEntitlementReconciliationService {
  return new MerchantKnowledgeEntitlementReconciliationService({
    database,
    queue: queue as never,
  });
}

describeWithDatabase("Merchant Knowledge entitlement reconciliation PostgreSQL", () => {
  it.each(["WEB_PAGE", "CSV", "XLSX"] as const)(
    "creates one concurrent-safe %s replacement, copies only its locator, and ignores the pending plan",
    async (dataFormatKey) => {
      const database = new PrismaClient({ datasourceUrl: testDatabaseUrl });
      const fixture = await createFixture(database, {
        dataFormatKey,
        purposeKey: dataFormatKey === "WEB_PAGE" ? "COMPANY_INFORMATION" : "PRODUCT_INFORMATION",
        maxContentUnitsPerSource: 10,
        pendingPlanMaxContentUnits: 20,
      });
      const source = await addSource(database, fixture, {
        dataFormatKey,
        purposeKey: dataFormatKey === "WEB_PAGE" ? "COMPANY_INFORMATION" : "PRODUCT_INFORMATION",
        contentUnits: 15,
      });
      const queue = { add: vi.fn().mockResolvedValue(undefined) };
      try {
        const first = reconciliationService(database, queue);
        const concurrent = reconciliationService(database, queue);
        const outcomes = await Promise.all([
          first.reconcileOnce({ shopPageSize: 100 }),
          concurrent.reconcileOnce({ shopPageSize: 100 }),
        ]);
        expect(outcomes.reduce((sum, outcome) => sum + outcome.contentLimitRevisionsCreated, 0)).toBe(1);
        expect(queue.add).toHaveBeenCalledOnce();

        const revisions = await database.merchantKnowledgeSourceRevision.findMany({
          where: { sourceId: source.sourceId },
          orderBy: { generation: "asc" },
          select: {
            generation: true,
            reason: true,
            status: true,
            requestedUrl: true,
            uploadedAssetId: true,
            normalizedContent: true,
            contentUnits: true,
            contentHash: true,
            resolvedUrl: true,
          },
        });
        expect(revisions).toHaveLength(2);
        expect(revisions[0]).toMatchObject({
          generation: 1,
          status: "ACTIVE",
          normalizedContent: "retained normalized content",
        });
        expect(revisions[1]).toMatchObject({
          generation: 2,
          reason: "ENTITLEMENT_CHANGE",
          status: "PENDING",
          normalizedContent: null,
          contentUnits: null,
          contentHash: null,
          resolvedUrl: null,
          requestedUrl: dataFormatKey === "WEB_PAGE" ? "https://merchant.example/knowledge" : null,
          uploadedAssetId: dataFormatKey === "WEB_PAGE" ? null : source.assetId,
        });
        await expect(
          database.merchantKnowledgeSource.findUniqueOrThrow({
            where: { id: source.sourceId },
            select: { currentGeneration: true },
          }),
        ).resolves.toEqual({ currentGeneration: 2 });

        const job = queue.add.mock.calls[0]?.[1];
        expect(queue.add.mock.calls[0]?.[2]).toEqual({
          jobId: createMerchantKnowledgeProcessJobId(job),
        });
      } finally {
        await removeFixture(database, fixture);
        await database.$disconnect();
      }
    },
  );

  it("leaves a failed enqueue PENDING for existing B1 reconciliation to recover", async () => {
    const database = new PrismaClient({ datasourceUrl: testDatabaseUrl });
    const fixture = await createFixture(database);
    const source = await addSource(database, fixture);
    const failedQueue = { add: vi.fn().mockRejectedValue(new Error("simulated queue outage")) };
    try {
      await expect(reconciliationService(database, failedQueue).reconcileOnce()).resolves.toMatchObject({
        contentLimitRevisionsCreated: 1,
        enqueueFailures: 1,
      });
      const pending = await database.merchantKnowledgeSourceRevision.findFirstOrThrow({
        where: { sourceId: source.sourceId, generation: 2 },
        select: { id: true, status: true, requestedAt: true },
      });
      expect(pending.status).toBe("PENDING");

      const recoveredQueue = { add: vi.fn().mockResolvedValue(undefined) };
      const b1 = new MerchantKnowledgeReconciliationService(
        database,
        recoveredQueue as never,
        new MerchantKnowledgeEntitlementService(database),
      );
      await expect(b1.reconcilePendingOnce()).resolves.toMatchObject({ enqueued: 1 });
      const replacementJobId = failedQueue.add.mock.calls[0]?.[2].jobId;
      expect(recoveredQueue.add.mock.calls[0]?.[2].jobId).toBe(replacementJobId);
      expect(replacementJobId).toBe(createMerchantKnowledgeProcessJobId({
        schemaVersion: 1,
        shopId: fixture.shopId,
        sourceRevisionId: pending.id,
        generation: 2,
        requestedAt: pending.requestedAt.toISOString(),
      }));
      await expect(
        database.merchantKnowledgeSourceRevision.count({ where: { sourceId: source.sourceId } }),
      ).resolves.toBe(2);
    } finally {
      await removeFixture(database, fixture);
      await database.$disconnect();
    }
  });

  it("does not mutate disallowed types or allowed sources beyond the current source count", async () => {
    const database = new PrismaClient({ datasourceUrl: testDatabaseUrl });
    const fixture = await createFixture(database, {
      maxKnowledgeSources: 1,
      maxContentUnitsPerSource: 5,
      allowedSourceTypes: [{ purposeKey: "COMPANY_INFORMATION", dataFormatKey: "WEB_PAGE" }],
    });
    const first = await addSource(database, fixture, { position: 0, contentUnits: 3 });
    const disallowed = await addSource(database, fixture, {
      purposeKey: "FAQ",
      dataFormatKey: "WEB_PAGE",
      position: 1,
      contentUnits: 20,
    });
    const beyondCount = await addSource(database, fixture, {
      position: 2,
      contentUnits: 20,
    });
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    try {
      await expect(reconciliationService(database, queue).reconcileOnce()).resolves.toMatchObject({
        sourceTypeDormant: 1,
        sourceCountDormant: 1,
        contentLimitRevisionsCreated: 0,
      });
      expect(queue.add).not.toHaveBeenCalled();
      await expect(
        database.merchantKnowledgeSource.findMany({
          where: { id: { in: [first.sourceId, disallowed.sourceId, beyondCount.sourceId] } },
          select: { id: true, currentGeneration: true },
        }),
      ).resolves.toEqual(expect.arrayContaining([
        { id: first.sourceId, currentGeneration: 1 },
        { id: disallowed.sourceId, currentGeneration: 1 },
        { id: beyondCount.sourceId, currentGeneration: 1 },
      ]));
      await expect(
        database.merchantKnowledgeSourceRevision.count({
          where: { sourceId: { in: [first.sourceId, disallowed.sourceId, beyondCount.sourceId] } },
        }),
      ).resolves.toBe(3);
    } finally {
      await removeFixture(database, fixture);
      await database.$disconnect();
    }
  });

  it.each([10, 7])("does not create work when active content is equal to or below the current limit (%s)", async (contentUnits) => {
    const database = new PrismaClient({ datasourceUrl: testDatabaseUrl });
    const fixture = await createFixture(database, { maxContentUnitsPerSource: 10 });
    const source = await addSource(database, fixture, { contentUnits });
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    try {
      await expect(reconciliationService(database, queue).reconcileOnce()).resolves.toMatchObject({
        contentLimitRevisionsCreated: 0,
      });
      expect(queue.add).not.toHaveBeenCalled();
      await expect(
        database.merchantKnowledgeSourceRevision.count({ where: { sourceId: source.sourceId } }),
      ).resolves.toBe(1);
    } finally {
      await removeFixture(database, fixture);
      await database.$disconnect();
    }
  });

  it("does no work for an increase or source-type re-entitlement alone", async () => {
    const database = new PrismaClient({ datasourceUrl: testDatabaseUrl });
    const fixture = await createFixture(database, {
      maxContentUnitsPerSource: 10,
      contentUnits: 7,
    });
    const source = await addSource(database, fixture, { contentUnits: 7 });
    const queue = { add: vi.fn().mockResolvedValue(undefined) };
    try {
      const planFeature = await database.billingPlanFeature.findUniqueOrThrow({
        where: { planId_featureId: { planId: fixture.planIds[0]!, featureId: fixture.featureId } },
        select: { id: true, configuration: true },
      });
      const baseConfiguration = planFeature.configuration as {
        schemaVersion: number;
        maxKnowledgeSources: number;
        maxContentUnitsPerSource: number;
        allowedSourceTypes: Array<{ purposeKey: string; dataFormatKey: string }>;
      };
      const service = reconciliationService(database, queue);
      await service.reconcileOnce();

      await database.billingPlanFeature.update({
        where: { id: planFeature.id },
        data: {
          configuration: {
            ...baseConfiguration,
            allowedSourceTypes: [],
          },
        },
      });
      await service.reconcileOnce();
      await database.billingPlanFeature.update({
        where: { id: planFeature.id },
        data: {
          configuration: {
            ...baseConfiguration,
            maxContentUnitsPerSource: 20,
          },
        },
      });
      await service.reconcileOnce();

      expect(queue.add).not.toHaveBeenCalled();
      await expect(
        database.merchantKnowledgeSourceRevision.count({ where: { sourceId: source.sourceId } }),
      ).resolves.toBe(1);
    } finally {
      await removeFixture(database, fixture);
      await database.$disconnect();
    }
  });
});