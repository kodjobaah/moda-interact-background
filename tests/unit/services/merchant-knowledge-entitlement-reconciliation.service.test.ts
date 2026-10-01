import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MerchantKnowledgeEntitlementReconciliationService } from "../../../src/services/merchant-knowledge-entitlement-reconciliation.service.js";

const configuration = {
  schemaVersion: 1,
  maxKnowledgeSources: 2,
  maxContentUnitsPerSource: 10,
  allowedSourceTypes: [{ purposeKey: "COMPANY_INFORMATION", dataFormatKey: "WEB_PAGE" }],
};

function createHarness(options?: {
  contentUnits?: number | null;
  currentGeneration?: number;
  newerWork?: { id: string } | null;
  sourceIds?: string[];
  queueError?: Error;
}) {
  const revisionCreate = vi.fn().mockImplementation(async ({ data }) => ({
    id: "replacement-1",
    generation: data.generation,
    requestedAt: data.requestedAt,
  }));
  const sourceUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const activeRevision = {
    id: "active-1",
    generation: 2,
    contentUnits: options && "contentUnits" in options ? options.contentUnits : 14,
    requestedUrl: "https://merchant.example/policies",
    uploadedAssetId: null,
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "source-1" }]),
    subscription: {
      findUnique: vi.fn().mockResolvedValue({
        status: "ACTIVE",
        planId: "plan-1",
        plan: {
          features: [{
            configuration,
            feature: {
              activationMode: "MERCHANT_OPT_IN",
              shopPreferences: [{ enabled: true }],
            },
          }],
        },
      }),
    },
    merchantKnowledgeSource: {
      findUnique: vi.fn().mockResolvedValue({
        id: "source-1",
        shopId: "shop-1",
        currentGeneration: options?.currentGeneration ?? 2,
        purpose: { key: "COMPANY_INFORMATION", active: true },
        dataFormat: { key: "WEB_PAGE", active: true },
        purposeDataFormat: { purposeId: "purpose-1", dataFormatId: "format-1" },
      }),
      findMany: vi.fn().mockResolvedValue([{ id: "source-1" }]),
      updateMany: sourceUpdateMany,
    },
    merchantKnowledgeSourceRevision: {
      findFirst: vi.fn().mockImplementation(async ({ where }) =>
        where.status === "ACTIVE" ? activeRevision : options?.newerWork ?? null),
      create: revisionCreate,
    },
  };
  const subscriptionFindMany = vi.fn().mockResolvedValue([{ shopId: "shop-1" }]);
  const sourceFindMany = vi.fn().mockResolvedValue((options?.sourceIds ?? ["source-1"]).map((id) => ({ id })));
  const transaction = vi.fn(async (callback: (transactionClient: unknown) => unknown) => callback(tx));
  const add = options?.queueError
    ? vi.fn().mockRejectedValue(options.queueError)
    : vi.fn().mockResolvedValue(undefined);
  const database = {
    $transaction: transaction,
    subscription: {
      findMany: subscriptionFindMany,
      findUnique: tx.subscription.findUnique,
    },
    merchantKnowledgeSource: {
      findMany: sourceFindMany,
      findUnique: tx.merchantKnowledgeSource.findUnique,
    },
  } as unknown as PrismaClient;
  const service = new MerchantKnowledgeEntitlementReconciliationService({
    database,
    queue: { add } as unknown as Queue,
    now: () => new Date("2026-10-01T12:00:00.000Z"),
  });
  return {
    service,
    subscriptionFindMany,
    sourceFindMany,
    transaction,
    add,
    sourceUpdateMany,
    revisionCreate,
    tx,
  };
}

describe("MerchantKnowledgeEntitlementReconciliationService", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  it("creates one deterministic WEB_PAGE replacement only when ACTIVE content exceeds the current limit", async () => {
    await expect(harness.service.reconcileOnce()).resolves.toEqual({
      shopsScanned: 1,
      sourcesScanned: 1,
      contentLimitRevisionsCreated: 1,
      sourceTypeDormant: 0,
      sourceCountDormant: 0,
      enqueueFailures: 0,
    });
    expect(harness.subscriptionFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        shop: {
          is: {
            featurePreferences: {
              some: expect.objectContaining({ enabled: true }),
            },
          },
        },
      }),
      orderBy: { shopId: "asc" },
      take: 100,
    }));
    expect(harness.tx.$queryRaw).toHaveBeenCalledOnce();
    expect(harness.sourceUpdateMany).toHaveBeenCalledWith({
      where: { id: "source-1", currentGeneration: 2 },
      data: { currentGeneration: { increment: 1 } },
    });
    expect(harness.revisionCreate).toHaveBeenCalledWith({
      data: {
        sourceId: "source-1",
        generation: 3,
        reason: "ENTITLEMENT_CHANGE",
        status: "PENDING",
        requestedAt: new Date("2026-10-01T12:00:00.000Z"),
        requestedUrl: "https://merchant.example/policies",
        uploadedAssetId: null,
      },
      select: { id: true, generation: true, requestedAt: true },
    });
    expect(harness.add).toHaveBeenCalledOnce();
    expect(harness.add.mock.calls[0]?.[2]).toEqual({
      jobId: expect.stringContaining("merchant-knowledge"),
    });
  });

  it.each([10, 7, null])("does nothing when content units are equal to, below, or unavailable against the limit (%s)", async (contentUnits) => {
    harness = createHarness({ contentUnits });
    await expect(harness.service.reconcileOnce()).resolves.toMatchObject({
      contentLimitRevisionsCreated: 0,
      enqueueFailures: 0,
    });
    expect(harness.sourceUpdateMany).not.toHaveBeenCalled();
    expect(harness.revisionCreate).not.toHaveBeenCalled();
    expect(harness.add).not.toHaveBeenCalled();
  });

  it("does not create a duplicate when newer PENDING or PROCESSING work exists", async () => {
    for (const status of ["PENDING", "PROCESSING"] as const) {
      harness = createHarness({ newerWork: { id: `newer-${status}` } });
      await expect(harness.service.reconcileOnce()).resolves.toMatchObject({
        contentLimitRevisionsCreated: 0,
      });
      expect(harness.sourceUpdateMany).not.toHaveBeenCalled();
      expect(harness.add).not.toHaveBeenCalled();
    }
  });

  it("leaves the durable PENDING replacement in place when queue publication fails", async () => {
    harness = createHarness({ queueError: new Error("queue unavailable") });
    await expect(harness.service.reconcileOnce()).resolves.toMatchObject({
      contentLimitRevisionsCreated: 1,
      enqueueFailures: 1,
    });
    expect(harness.revisionCreate).toHaveBeenCalledOnce();
    expect(harness.add).toHaveBeenCalledOnce();
  });

  it("advances bounded shop scans with a keyset cursor and resets after the final page", async () => {
    const subscriptionFindMany = vi.fn()
      .mockResolvedValueOnce([{ shopId: "shop-a" }])
      .mockResolvedValueOnce([{ shopId: "shop-b" }])
      .mockResolvedValueOnce([]);
    const db = {
      $transaction: vi.fn(),
      subscription: { findMany: subscriptionFindMany },
      merchantKnowledgeSource: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;
    const service = new MerchantKnowledgeEntitlementReconciliationService({
      database: db,
      queue: { add: vi.fn() } as unknown as Queue,
    });
    await service.reconcileOnce({ shopPageSize: 1 });
    await service.reconcileOnce({ shopPageSize: 1 });
    expect(subscriptionFindMany.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      where: expect.objectContaining({ shopId: { gt: "shop-a" } }),
    }));
    await service.reconcileOnce({ shopPageSize: 1 });
    subscriptionFindMany.mockResolvedValueOnce([{ shopId: "shop-a" }]);
    await service.reconcileOnce({ shopPageSize: 1 });
    expect(subscriptionFindMany.mock.calls[3]?.[0]).toEqual(expect.objectContaining({
      where: expect.not.objectContaining({ shopId: expect.anything() }),
    }));
  });

  it.each([0, -1, 501, 1.5])("rejects invalid shop page size %s", async (shopPageSize) => {
    await expect(harness.service.reconcileOnce({ shopPageSize })).rejects.toThrow(RangeError);
    expect(harness.subscriptionFindMany).not.toHaveBeenCalled();
  });
});