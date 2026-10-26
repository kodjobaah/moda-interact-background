import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";
import { describe, it, expect } from "vitest";
import { connectionRedis } from "../../src/lib/redis.js";
import { MERCHANT_COMMUNICATIONS_QUEUE_NAME } from "../../src/domain/translation-batch.js";
import { TemplateTranslationRepository } from "../../src/services/template-translation/repository.js";
import { TemplateTranslationCoordinator } from "../../src/services/template-translation/reconciliation.js";
import { TemplateTranslationBatchLifecycle } from "../../src/services/template-translation/lifecycle.js";
import { type TranslationProvider, type TranslationRequest } from "../../src/providers/translation.provider.js";
import {
  config, seed, cleanup, fakeProvider, type Fixture,
} from "../helpers/whatsapp-template-translation-fixtures.js";

const describeWithDb = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;

describeWithDb("ARCH-047 keyed-template translation PostgreSQL + BullMQ", () => {
  it("atomically allocates a single Batch to concurrent executions; persists keyed JSONB only", async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const db = new PrismaClient();
    const queue = new Queue(MERCHANT_COMMUNICATIONS_QUEUE_NAME, { connection: connectionRedis });
    let fixture: Fixture | undefined;
    try {
      fixture = await seed(db);
      const repository = new TemplateTranslationRepository(db);
      const captured: TranslationRequest[] = [];
      const provider = fakeProvider({ captured });
      const lifecycle = new TemplateTranslationBatchLifecycle({
        repository, queue, runtimeConfig: config, providerFactory: () => provider,
        credentialResolverFactory: async () => ({ resolve: async () => "test-token" }),
      });
      const coordinator = new TemplateTranslationCoordinator({ repository, lifecycle, queue, runtimeConfig: config });
      const [left, right] = await Promise.all([
        coordinator.executeTemplateTranslation(fixture.run.id), coordinator.executeTemplateTranslation(fixture.run.id),
      ]);
      expect([left.status, right.status].sort()).toEqual(["scheduled", "unchanged"]);
      const batches = await db.whatsAppTemplateTranslationBatch.findMany({ where: { runId: fixture.run.id }, include: { items: true } });
      expect(batches).toHaveLength(1);
      expect(batches[0]!.items).toHaveLength(2);
      const batchId = batches[0]!.id;
      expect(await lifecycle.submit(batchId)).toBe("submitted");
      expect(captured.map((c) => c.targetLanguageTag).sort()).toEqual(["de-DE", "fr-FR"]);
      expect(captured.every((c) => c.translationFormat === "keyed-segments-v1")).toBe(true);
      expect(await lifecycle.poll(batchId, 1)).toBe("completed");
      expect(await lifecycle.ingest(batchId)).toBe("completed");
      expect(await lifecycle.ingest(batchId)).toBe("skipped");
      const items = await db.whatsAppTemplateTranslationItem.findMany({ where: { runId: fixture.run.id } });
      expect(items).toHaveLength(2);
      expect(items.every((item) => item.status === "AVAILABLE" && item.currentBatchId === null && item.outputContentHash?.length === 64)).toBe(true);
      expect(items[0]!.translatedAst).toMatchObject({
        schemaVersion: 1, segments: [
          { key: "header.text" }, { key: "body.text" }, { key: "buttons.0.text" },
        ],
      });
      expect((await db.whatsAppTemplateTranslationRun.findUniqueOrThrow({ where: { id: fixture.run.id } })).status).toBe("COMPLETED");
      expect((await db.whatsAppTemplateLocale.findUniqueOrThrow({ where: { id: fixture.locale.id } })).localeAst).toEqual({ source: "never touch me" });
      await coordinator.close();
    } finally {
      if (fixture) await cleanup(db, fixture, queue);
      await queue.close();
      await db.$disconnect();
    }
  }, 45_000);

  it("retries only failing language, leaving successful language and historical Batch untouched", async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const db = new PrismaClient();
    const queue = new Queue(MERCHANT_COMMUNICATIONS_QUEUE_NAME, { connection: connectionRedis });
    let fixture: Fixture | undefined;
    try {
      fixture = await seed(db);
      const repository = new TemplateTranslationRepository(db);
      const failed = new Set(["de-DE"]);
      const provider = fakeProvider({ failures: failed, captured: [] });
      const lifecycle = new TemplateTranslationBatchLifecycle({
        repository, queue, runtimeConfig: config, providerFactory: () => provider,
        credentialResolverFactory: async () => ({ resolve: async () => "test-token" }),
      });
      const coordinator = new TemplateTranslationCoordinator({ repository, lifecycle, queue, runtimeConfig: config });
      const first = await coordinator.executeTemplateTranslation(fixture.run.id);
      if (first.status !== "scheduled") throw new Error("expected first batch");
      await lifecycle.submit(first.batchId);
      await lifecycle.poll(first.batchId, 1);
      await lifecycle.ingest(first.batchId);
      const afterFirst = await db.whatsAppTemplateTranslationItem.findMany({ where: { runId: fixture.run.id } });
      expect(afterFirst.filter((item) => item.status === "AVAILABLE")).toHaveLength(1);
      expect(afterFirst.filter((item) => item.status === "PENDING" && item.retryCount === 1)).toHaveLength(1);
      const preservedHash = afterFirst.find((item) => item.status === "AVAILABLE")!.outputContentHash;
      failed.clear();
      await db.whatsAppTemplateTranslationItem.updateMany({ where: { runId: fixture.run.id, status: "PENDING" }, data: { nextAttemptAt: new Date(0) } });
      const second = await coordinator.executeTemplateTranslation(fixture.run.id);
      if (second.status !== "scheduled") throw new Error("expected retry batch");
      expect((await db.whatsAppTemplateTranslationBatchItem.count({ where: { batchId: second.batchId } }))).toBe(1);
      await lifecycle.submit(second.batchId);
      await lifecycle.poll(second.batchId, 1);
      await lifecycle.ingest(second.batchId);
      expect(await lifecycle.ingest(first.batchId)).toBe("skipped");
      const finalItems = await db.whatsAppTemplateTranslationItem.findMany({ where: { runId: fixture.run.id } });
      expect(finalItems.every((item) => item.status === "AVAILABLE")).toBe(true);
      expect(finalItems.find((item) => item.outputContentHash === preservedHash)).toBeDefined();
      expect((await db.whatsAppTemplateTranslationRun.findUniqueOrThrow({ where: { id: fixture.run.id } })).status).toBe("COMPLETED");
      await coordinator.close();
    } finally {
      if (fixture) await cleanup(db, fixture, queue);
      await queue.close();
      await db.$disconnect();
    }
  }, 45_000);

  it("holds uncertain provider creation for correlation and adopts the original Batch", async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const db = new PrismaClient();
    const queue = new Queue(MERCHANT_COMMUNICATIONS_QUEUE_NAME, { connection: connectionRedis });
    let fixture: Fixture | undefined;
    try {
      fixture = await seed(db);
      const repository = new TemplateTranslationRepository(db);
      const originalProvider = fakeProvider({ captured: [] });
      let createAttempts = 0;
      const provider: TranslationProvider = {
        ...originalProvider,
        async createBatch() {
          createAttempts++;
          throw Object.assign(new Error("provider acceptance uncertain"), { classification: "AMBIGUOUS_CREATE" });
        },
        async findBatchByCorrelation({ logicalBatchId }) {
          return { kind: "match", batch: {
            provider: "openai", providerBatchId: `accepted-${logicalBatchId}`,
            logicalBatchId, providerStatus: "completed", status: "completed",
            inputFileId: "recovered-input", outputFileId: "recovered-output", errorFileId: null,
            failureCode: null, createdAt: null, completedAt: null,
          } };
        },
      };
      const lifecycle = new TemplateTranslationBatchLifecycle({
        repository, queue, runtimeConfig: config, providerFactory: () => provider,
        credentialResolverFactory: async () => ({ resolve: async () => "test-token" }),
      });
      const coordinator = new TemplateTranslationCoordinator({ repository, lifecycle, queue, runtimeConfig: config });
      const started = await coordinator.executeTemplateTranslation(fixture.run.id);
      if (started.status !== "scheduled") throw new Error("batch not scheduled");
      await expect(lifecycle.submit(started.batchId)).rejects.toThrow("provider acceptance uncertain");
      expect((await db.whatsAppTemplateTranslationBatch.findUniqueOrThrow({ where: { id: started.batchId } })).status)
        .toBe("SUBMISSION_UNKNOWN");
      const reconciliation = await coordinator.reconcile(100);
      expect(reconciliation.ambiguous).toBe(0);
      expect(createAttempts).toBe(1);
      const recovered = await db.whatsAppTemplateTranslationBatch.findUniqueOrThrow({ where: { id: started.batchId } });
      expect(recovered.status).toBe("PROVIDER_COMPLETED");
      expect(recovered.providerBatchId).toBe(`accepted-${started.batchId}`);
      expect(await db.whatsAppTemplateTranslationBatch.count({ where: { runId: fixture.run.id } })).toBe(1);
      await coordinator.close();
    } finally {
      if (fixture) await cleanup(db, fixture, queue);
      await queue.close();
      await db.$disconnect();
    }
  }, 45_000);

  it("logs/retries provider poll exceptions and ignores stale poll sequence after recovery", async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const db = new PrismaClient();
    const queue = new Queue(MERCHANT_COMMUNICATIONS_QUEUE_NAME, { connection: connectionRedis });
    let fixture: Fixture | undefined;
    try {
      fixture = await seed(db);
      const repository = new TemplateTranslationRepository(db);
      const original = fakeProvider({ captured: [] });
      let reads = 0;
      const provider: TranslationProvider = {
        ...original,
        async retrieveBatch(id) {
          reads++;
          if (reads === 1) throw new Error("transient provider timeout");
          return original.retrieveBatch(id);
        },
      };
      const lifecycle = new TemplateTranslationBatchLifecycle({
        repository, queue, runtimeConfig: config, providerFactory: () => provider,
        credentialResolverFactory: async () => ({ resolve: async () => "test-token" }),
      });
      const coordinator = new TemplateTranslationCoordinator({ repository, lifecycle, queue, runtimeConfig: config });
      const started = await coordinator.executeTemplateTranslation(fixture.run.id);
      if (started.status !== "scheduled") throw new Error("batch not scheduled");
      await lifecycle.submit(started.batchId);
      expect(await lifecycle.poll(started.batchId, 1)).toBe("rescheduled");
      expect(await lifecycle.poll(started.batchId, 1)).toBe("skipped");
      expect(await lifecycle.poll(started.batchId, 2)).toBe("completed");
      expect(reads).toBe(2);
      expect((await db.whatsAppTemplateTranslationBatch.findUniqueOrThrow({ where: { id: started.batchId } })).status)
        .toBe("PROVIDER_COMPLETED");
      await coordinator.close();
    } finally {
      if (fixture) await cleanup(db, fixture, queue);
      await queue.close();
      await db.$disconnect();
    }
  }, 45_000);


  it("does not admit stale-source results after immutable definition hash drifts", async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    const db = new PrismaClient();
    const queue = new Queue(MERCHANT_COMMUNICATIONS_QUEUE_NAME, { connection: connectionRedis });
    let fixture: Fixture | undefined;
    try {
      fixture = await seed(db);
      const repository = new TemplateTranslationRepository(db);
      const provider = fakeProvider({ captured: [] });
      const lifecycle = new TemplateTranslationBatchLifecycle({
        repository, queue, runtimeConfig: config, providerFactory: () => provider,
        credentialResolverFactory: async () => ({ resolve: async () => "test-token" }),
      });
      const coordinator = new TemplateTranslationCoordinator({ repository, lifecycle, queue, runtimeConfig: config });
      const started = await coordinator.executeTemplateTranslation(fixture.run.id);
      if (started.status !== "scheduled") throw new Error("batch not scheduled");
      await lifecycle.submit(started.batchId);
      await lifecycle.poll(started.batchId, 1);
      await db.whatsAppTemplateDefinition.update({
        where: { id: fixture.definition.id }, data: { sourceHash: "b".repeat(64) },
      });
      await expect(lifecycle.ingest(started.batchId)).rejects.toThrow("STALE_TEMPLATE_DEFINITION_HASH");
      expect((await db.whatsAppTemplateTranslationRun.findUniqueOrThrow({ where: { id: fixture.run.id } })).status).toBe("FAILED");
      expect((await db.whatsAppTemplateTranslationItem.findMany({ where: { runId: fixture.run.id } })).every(
        (item) => item.translatedAst === null && item.status === "FAILED",
      )).toBe(true);
      await coordinator.close();
    } finally {
      if (fixture) await cleanup(db, fixture, queue);
      await queue.close();
      await db.$disconnect();
    }
  }, 45_000);

});
