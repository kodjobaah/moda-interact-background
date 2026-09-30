import "dotenv/config";

import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { MerchantKnowledgeUploadCleanupService } from "../../src/services/merchant-knowledge-upload-cleanup.service.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDisposableDatabase = testDatabaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe
  : describe.skip;

interface Fixture {
  shopId: string;
  sourceId: string;
  purposeId: string;
  dataFormatId: string;
  createdPurposeDataFormat: boolean;
  assetIds: string[];
  revisionIds: string[];
}

async function createFixture(database: PrismaClient): Promise<Fixture> {
  const shopId = randomUUID();
  const sourceId = randomUUID();
  const [purpose, dataFormat] = await Promise.all([
    database.merchantKnowledgePurpose.findUniqueOrThrow({
      where: { key: "FAQ" },
      select: { id: true },
    }),
    database.merchantKnowledgeDataFormat.findUniqueOrThrow({
      where: { key: "CSV" },
      select: { id: true },
    }),
  ]);
  let mapping = await database.merchantKnowledgePurposeDataFormat.findUnique({
    where: { purposeId_dataFormatId: { purposeId: purpose.id, dataFormatId: dataFormat.id } },
    select: { purposeId: true },
  });
  const createdPurposeDataFormat = !mapping;
  mapping ??= await database.merchantKnowledgePurposeDataFormat.create({
    data: { purposeId: purpose.id, dataFormatId: dataFormat.id },
    select: { purposeId: true },
  });

  await database.shop.create({ data: { id: shopId, domain: `${shopId}.test` } });
  await database.merchantKnowledgeSource.create({
    data: {
      id: sourceId,
      shopId,
      purposeId: mapping.purposeId,
      dataFormatId: dataFormat.id,
      name: "Cleanup fixture",
      languageTag: "en",
      position: 0,
      currentGeneration: 1,
    },
  });

  return {
    shopId,
    sourceId,
    purposeId: purpose.id,
    dataFormatId: dataFormat.id,
    createdPurposeDataFormat,
    assetIds: [],
    revisionIds: [],
  };
}

async function createAsset(
  database: PrismaClient,
  fixture: Fixture,
  input: {
    status: "PENDING_UPLOAD" | "AVAILABLE" | "DELETED";
    createdAt: Date;
    uploadExpiresAt: Date;
    keySuffix: string;
  },
): Promise<string> {
  const id = randomUUID();
  const dataFormat = await database.merchantKnowledgeDataFormat.findUniqueOrThrow({
    where: { key: "CSV" },
    select: { id: true },
  });
  await database.merchantKnowledgeUploadedAsset.create({
    data: {
      id,
      shopId: fixture.shopId,
      dataFormatId: dataFormat.id,
      status: input.status,
      objectKey: `${fixture.shopId}/${input.keySuffix}.csv`,
      originalFileName: `${input.keySuffix}.csv`,
      contentType: "text/csv",
      sizeBytes: 1n,
      sha256: "0".repeat(64),
      uploadExpiresAt: input.uploadExpiresAt,
      availableAt: input.status === "AVAILABLE" ? input.createdAt : null,
      createdAt: input.createdAt,
    },
  });
  fixture.assetIds.push(id);
  return id;
}

async function addRevision(database: PrismaClient, fixture: Fixture, assetId: string): Promise<void> {
  const revisionId = randomUUID();
  await database.merchantKnowledgeSourceRevision.create({
    data: {
      id: revisionId,
      sourceId: fixture.sourceId,
      uploadedAssetId: assetId,
      generation: fixture.revisionIds.length + 1,
      reason: "CREATE",
      status: "PENDING",
    },
  });
  fixture.revisionIds.push(revisionId);
}

async function removeFixture(database: PrismaClient, fixture: Fixture): Promise<void> {
  await database.merchantKnowledgeSourceRevision.deleteMany({ where: { id: { in: fixture.revisionIds } } });
  await database.merchantKnowledgeUploadedAsset.deleteMany({ where: { id: { in: fixture.assetIds } } });
  await database.merchantKnowledgeSource.deleteMany({ where: { id: fixture.sourceId } });
  await database.shop.deleteMany({ where: { id: fixture.shopId } });
  if (fixture.createdPurposeDataFormat) {
    await database.merchantKnowledgePurposeDataFormat.deleteMany({
      where: { purposeId: fixture.purposeId, dataFormatId: fixture.dataFormatId },
    });
  }
}

describeWithDisposableDatabase("Merchant Knowledge uploaded-asset cleanup PostgreSQL", () => {
  it("tombstones eligible orphans, preserves referenced/recent assets, rechecks races, and retries failed deletes", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const database = new PrismaClient({ datasourceUrl: testDatabaseUrl });
    const fixture = await createFixture(database);
    const now = new Date("2026-09-30T12:00:00.000Z");
    const old = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    const expired = await createAsset(database, fixture, {
      status: "PENDING_UPLOAD",
      createdAt: old,
      uploadExpiresAt: new Date(now.getTime() - 1_000),
      keySuffix: "expired",
    });
    const orphan = await createAsset(database, fixture, {
      status: "AVAILABLE",
      createdAt: old,
      uploadExpiresAt: new Date(now.getTime() + 60_000),
      keySuffix: "orphan",
    });
    const recent = await createAsset(database, fixture, {
      status: "AVAILABLE",
      createdAt: new Date(now.getTime() - 60_000),
      uploadExpiresAt: new Date(now.getTime() + 60_000),
      keySuffix: "recent",
    });
    const referenced = await createAsset(database, fixture, {
      status: "AVAILABLE",
      createdAt: old,
      uploadExpiresAt: new Date(now.getTime() + 60_000),
      keySuffix: "referenced",
    });
    await addRevision(database, fixture, referenced);
    const retry = await createAsset(database, fixture, {
      status: "DELETED",
      createdAt: old,
      uploadExpiresAt: new Date(now.getTime() - 60_000),
      keySuffix: "retry",
    });

    const deletedKeys: string[] = [];
    const r2 = {
      deleteObject: vi.fn(async ({ key }: { bucket: string; key: string }) => {
        if (key.endsWith("orphan.csv")) throw new Error("private storage detail");
        deletedKeys.push(key);
      }),
    };
    try {
      const service = new MerchantKnowledgeUploadCleanupService({
        database,
        r2,
        bucket: "private-bucket",
        now: () => now,
      });
      const result = await service.cleanupOnce();

      expect(result).toMatchObject({ scanned: 3, tombstoned: 2, deleted: 2, deleteFailed: 1 });
      expect(deletedKeys).toEqual(expect.arrayContaining([
        `${fixture.shopId}/expired.csv`,
        `${fixture.shopId}/retry.csv`,
      ]));
      const statuses = await database.merchantKnowledgeUploadedAsset.findMany({
        where: { id: { in: [expired, orphan, recent, referenced, retry] } },
        select: { id: true, status: true, failureCode: true },
      });
      expect(statuses).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: expired, status: "DELETED", failureCode: "UPLOAD_EXPIRED" }),
        expect.objectContaining({ id: orphan, status: "DELETED", failureCode: "UNREFERENCED_ASSET" }),
        expect.objectContaining({ id: recent, status: "AVAILABLE" }),
        expect.objectContaining({ id: referenced, status: "AVAILABLE" }),
        expect.objectContaining({ id: retry, status: "DELETED" }),
      ]));
      expect(r2.deleteObject).not.toHaveBeenCalledWith(expect.objectContaining({ key: `${fixture.shopId}/referenced.csv` }));

      const race = await createAsset(database, fixture, {
        status: "AVAILABLE",
        createdAt: old,
        uploadExpiresAt: new Date(now.getTime() + 60_000),
        keySuffix: "race",
      });
      const realFindMany = database.merchantKnowledgeUploadedAsset.findMany.bind(
        database.merchantKnowledgeUploadedAsset,
      );
      const selectThenReference = {
        ...database,
        merchantKnowledgeUploadedAsset: {
          ...database.merchantKnowledgeUploadedAsset,
          findMany: async (args: Parameters<typeof realFindMany>[0]) => {
            const rows = await realFindMany(args);
            if (rows.some((row) => row.id === race)) await addRevision(database, fixture, race);
            return rows;
          },
        },
      } as PrismaClient;
      const raceService = new MerchantKnowledgeUploadCleanupService({
        database: selectThenReference,
        r2,
        bucket: "private-bucket",
        now: () => now,
      });
      await raceService.cleanupOnce();
      expect(r2.deleteObject).not.toHaveBeenCalledWith(
        expect.objectContaining({ key: `${fixture.shopId}/race.csv` }),
      );
      await expect(database.merchantKnowledgeUploadedAsset.findUniqueOrThrow({
        where: { id: race },
        select: { status: true },
      })).resolves.toEqual({ status: "AVAILABLE" });
    } finally {
      await removeFixture(database, fixture);
      await database.$disconnect();
    }
  }, 30_000);

  it("advances beyond an earlier page of retained DELETED tombstones", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const database = new PrismaClient({ datasourceUrl: testDatabaseUrl });
    const fixture = await createFixture(database);
    const now = new Date("2026-09-30T12:00:00.000Z");
    const tombstoneTime = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const expired = await createAsset(database, fixture, {
      status: "PENDING_UPLOAD",
      createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      uploadExpiresAt: new Date(now.getTime() - 1_000),
      keySuffix: "later-expired",
    });
    const tombstones = await Promise.all(Array.from({ length: 101 }, (_, index) =>
      createAsset(database, fixture, {
        status: "DELETED",
        createdAt: tombstoneTime,
        uploadExpiresAt: new Date(now.getTime() - 60_000),
        keySuffix: `retained-${index}`,
      }),
    ));
    const deletedKeys: string[] = [];
    const realFindMany = database.merchantKnowledgeUploadedAsset.findMany.bind(
      database.merchantKnowledgeUploadedAsset,
    );
    const pageSizes: number[] = [];
    const pagedDatabase = {
      ...database,
      merchantKnowledgeUploadedAsset: {
        ...database.merchantKnowledgeUploadedAsset,
        findMany: async (args: Parameters<typeof realFindMany>[0]) => {
          pageSizes.push(args?.take ?? 0);
          return realFindMany(args);
        },
      },
    } as PrismaClient;
    try {
      const service = new MerchantKnowledgeUploadCleanupService({
        database: pagedDatabase,
        r2: { deleteObject: vi.fn(async ({ key }: { bucket: string; key: string }) => { deletedKeys.push(key); }) },
        bucket: "private-bucket",
        now: () => now,
      });

      const result = await service.cleanupOnce();

      expect(result).toMatchObject({ scanned: 102, tombstoned: 1, deleted: 102, deleteFailed: 0 });
      expect(pageSizes.length).toBeGreaterThan(1);
      expect(pageSizes.every((size) => size === 100)).toBe(true);
      expect(deletedKeys).toContain(`${fixture.shopId}/later-expired.csv`);
      const expiredAsset = await database.merchantKnowledgeUploadedAsset.findUniqueOrThrow({
        where: { id: expired },
        select: { status: true, failureCode: true },
      });
      expect(expiredAsset).toEqual({ status: "DELETED", failureCode: "UPLOAD_EXPIRED" });
      expect(tombstones).toHaveLength(101);
    } finally {
      await removeFixture(database, fixture);
      await database.$disconnect();
    }
  }, 30_000);
});
