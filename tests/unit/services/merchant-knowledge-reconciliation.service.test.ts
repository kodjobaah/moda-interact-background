import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MERCHANT_KNOWLEDGE_PROCESS_JOB_NAME,
  type MerchantKnowledgeProcessSourceRevisionJob,
} from "@modainteract/moda-interact-shared/merchant-knowledge";
import { createMerchantKnowledgeProcessJobId } from "@modainteract/moda-interact-shared/merchant-knowledge/node";

import { MerchantKnowledgeReconciliationService } from "../../../src/services/merchant-knowledge-reconciliation.service.js";

function createHarness(revisions: Array<Record<string, unknown>>) {
  const findMany = vi.fn().mockResolvedValue(revisions);
  const add = vi.fn().mockResolvedValue(undefined);
  const resolveSourceEligibility = vi.fn().mockResolvedValue({ eligible: true });
  const database = {
    merchantKnowledgeSourceRevision: { findMany },
  } as unknown as PrismaClient;
  const queue = { add } as unknown as Queue;
  const service = new MerchantKnowledgeReconciliationService(
    database,
    queue,
    { resolveSourceEligibility } as never,
  );
  return { service, findMany, add, resolveSourceEligibility };
}

function revision(
  id: string,
  generation: number,
  currentGeneration = generation,
): Record<string, unknown> {
  return {
    id,
    generation,
    requestedAt: new Date("2026-09-30T10:00:00.000Z"),
    source: { id: `source-${id}`, shopId: "shop-1", currentGeneration },
  };
}

describe("MerchantKnowledgeReconciliationService", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness([
      revision("eligible", 3),
      revision("stale", 2, 3),
      revision("dormant", 4),
    ]);
    harness.resolveSourceEligibility.mockImplementation(async (sourceId: string) => ({
      eligible: sourceId !== "source-dormant",
    }));
  });

  it("scans one bounded ordered PENDING page and enqueues only current eligible revisions", async () => {
    await expect(harness.service.reconcilePendingOnce()).resolves.toEqual({
      scanned: 3,
      enqueued: 1,
      skippedStale: 1,
      skippedDormant: 1,
    });
    expect(harness.findMany).toHaveBeenCalledWith({
      where: { status: "PENDING" },
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
      take: 100,
      select: {
        id: true,
        generation: true,
        requestedAt: true,
        source: { select: { id: true, shopId: true, currentGeneration: true } },
      },
    });
    const [name, job, options] = harness.add.mock.calls[0] as [
      string,
      MerchantKnowledgeProcessSourceRevisionJob,
      { jobId: string },
    ];
    expect(name).toBe(MERCHANT_KNOWLEDGE_PROCESS_JOB_NAME);
    expect(job).toEqual({
      schemaVersion: 1,
      shopId: "shop-1",
      sourceRevisionId: "eligible",
      generation: 3,
      requestedAt: "2026-09-30T10:00:00.000Z",
    });
    expect(options.jobId).toBe(createMerchantKnowledgeProcessJobId(job));
    expect(harness.resolveSourceEligibility).toHaveBeenCalledTimes(2);
  });

  it("converges repeated reconciliation through the same deterministic job id", async () => {
    const first = await harness.service.reconcilePendingOnce();
    const firstOptions = harness.add.mock.calls[0]?.[2];
    harness.add.mockClear();
    const second = await harness.service.reconcilePendingOnce();

    expect(first.enqueued).toBe(1);
    expect(second.enqueued).toBe(1);
    expect(harness.add.mock.calls[0]?.[2]).toEqual(firstOptions);
  });

  it.each([0, -1, 501, 1.5])("rejects invalid page size %s", async (pageSize) => {
    await expect(harness.service.reconcilePendingOnce({ pageSize })).rejects.toThrow(RangeError);
    expect(harness.findMany).not.toHaveBeenCalled();
  });

  it("accepts the maximum page size", async () => {
    await harness.service.reconcilePendingOnce({ pageSize: 500 });
    expect(harness.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }));
  });
});