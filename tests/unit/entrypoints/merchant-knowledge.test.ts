import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  assertWorkerReady,
  WORKER_DEPENDENCIES,
  type ReadinessProbe,
} from "../../../src/runtime/readiness.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = readFileSync(
  resolve(root, "src/entrypoints/merchant-knowledge.ts"),
  "utf8",
);
const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
) as { scripts: Record<string, string> };

describe("Merchant Knowledge worker entrypoint", () => {
  it("requires Redis and PostgreSQL before loading the worker", async () => {
    const redisCheck = vi.fn().mockResolvedValue(undefined);
    const postgresqlCheck = vi.fn().mockResolvedValue(undefined);
    const probes: ReadinessProbe[] = [
      { name: "redis", check: redisCheck },
      { name: "postgresql", check: postgresqlCheck },
    ];

    expect(
      WORKER_DEPENDENCIES["moda-merchant-knowledge-worker"],
    ).toEqual(["redis", "postgresql"]);
    await assertWorkerReady("moda-merchant-knowledge-worker", probes);
    expect(redisCheck).toHaveBeenCalledOnce();
    expect(postgresqlCheck).toHaveBeenCalledOnce();
  });

  it("starts one dedicated worker with both fixed leased schedules", () => {
    expect(source).toContain('serviceName: "moda-merchant-knowledge-worker"');
    expect(source).toContain("createMerchantKnowledgeWorker(processingService)");
    expect(source.match(/createMerchantKnowledgeWorker\(/g)).toHaveLength(1);
    expect(source.match(/startDynamicLeasedScheduler\(\{/g)).toHaveLength(3);

    expect(source).toContain(
      'leaseName: "MERCHANT_KNOWLEDGE_PENDING_RECONCILIATION"',
    );
    expect(source).toContain("intervalMs: 60_000");
    expect(source).toContain("runImmediately: true");
    expect(source).toContain(
      "merchantKnowledgeReconciliationService.reconcilePendingOnce",
    );
    expect(source).toContain("pageSize: 100");
    expect(source).toContain('leaseName: "MERCHANT_KNOWLEDGE_ENTITLEMENT_RECONCILIATION"');
    expect(source).toContain("intervalMs: 300_000");
    expect(source).toContain("merchantKnowledgeEntitlementReconciliationService.reconcileOnce");
    expect(source).toContain("shopPageSize: 100");

    expect(source).toContain(
      'leaseName: "MERCHANT_KNOWLEDGE_UPLOAD_CLEANUP"',
    );
    expect(source).toContain("intervalMs: 3_600_000");
    expect(source).toContain("uploadCleanupService.cleanupOnce()");
    expect(source).toContain('queueNames: ["merchant-knowledge"]');
  });

  it("closes worker, scheduler, queue, config, observability and Redis resources", () => {
    expect(source).toContain("...closeMerchantKnowledgeResources");
    expect(source).toContain("stopPendingReconciliation");
    expect(source).toContain("stopEntitlementReconciliation");
    expect(source).toContain("stopUploadCleanup");
    expect(source).toContain("closeWorkerObservability");
    expect(source).toContain("closeQueuePerformanceTelemetry");
    expect(source).toContain("backgroundRuntimeConfigService.close()");
    expect(source).toContain("connectionRedis.quit()");
    expect(source).toContain("prisma.$disconnect()");
  });

  it("exposes the dedicated start and readiness commands", () => {
    expect(packageJson.scripts["start:merchant-knowledge-worker"]).toBe(
      "node --import ./observability/merchant-knowledge.mjs dist/entrypoints/merchant-knowledge.js",
    );
    expect(packageJson.scripts["readiness:merchant-knowledge-worker"]).toBe(
      "node dist/readiness.js moda-merchant-knowledge-worker",
    );
  });
});