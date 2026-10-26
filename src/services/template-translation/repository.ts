import { randomUUID, createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../lib/db.js";
import { parseTemplateTranslationSnapshot, type TemplateSourceSnapshot, type KeyedTranslationResult, templateTranslationContentHash } from "./segment-codec.js";
import { translationItemRetryDisposition } from "../translation-batch-runtime/item-retry.js";

export type TemplateTranslationDatabase = Pick<typeof prisma, "$queryRaw" | "$executeRaw" | "$transaction">;
type SqlTransaction = { $queryRaw<T>(query: Prisma.Sql): Promise<T>; $executeRaw(query: Prisma.Sql): Promise<number> };

export type TemplateRunRecord = {
  id: string; definitionId: string; status: string; sourceHash: string;
  sourceSchemaVersion: number; sourceSnapshot: unknown; definitionSourceHash: string;
  sourceLanguageTag: string; provider: string; providerModelId: string;
  environment: string;
};
export type TemplateBatchRecord = TemplateRunRecord & {
  batchId: string; batchStatus: string; providerBatchId: string | null;
  inputFileId: string | null; outputFileId: string | null; errorFileId: string | null;
  pollSequence: number; submitAttemptCount: number;
  submittedAt: Date | null; submissionStartedAt: Date | null;
};
type ItemMembership = {
  translationItemId: string; providerCustomId: string; targetLanguageTag: string;
  currentBatchId: string | null; status: string; retryCount: number;
};

export class TemplateTranslationRepository {
  constructor(readonly db: TemplateTranslationDatabase = prisma) {}

  /** Reject malformed/stale persisted input durably; do not loop forever on a poison run. */
  async failRunInput(runId: string, code: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const changed = await tx.$executeRaw(Prisma.sql`
        UPDATE "whatsapp"."WhatsAppTemplateTranslationRun"
        SET "status" = 'FAILED', "failureCode" = ${code.slice(0, 128)},
          "completedAt" = NOW(), "updatedAt" = NOW()
        WHERE "id" = ${runId} AND "status" IN ('PENDING', 'PROCESSING')
      `);
      if (changed) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "whatsapp"."WhatsAppTemplateTranslationItem"
          SET "status" = 'FAILED', "failureCode" = ${code.slice(0, 128)},
            "currentBatchId" = NULL, "nextAttemptAt" = NULL, "updatedAt" = NOW()
          WHERE "runId" = ${runId} AND "status" = 'PENDING'
        `);
      }
    });
  }

  async loadRun(runId: string): Promise<TemplateRunRecord | null> {
    const rows = await this.db.$queryRaw<TemplateRunRecord[]>(Prisma.sql`
      SELECT r."id", r."definitionId", r."status", r."sourceHash", r."sourceSchemaVersion",
        r."sourceSnapshot", d."sourceHash" AS "definitionSourceHash",
        d."sourceLanguageTag", r."provider", r."providerModelId", m."environment"::text AS "environment"
      FROM "whatsapp"."WhatsAppTemplateTranslationRun" r
      JOIN "whatsapp"."WhatsAppTemplateDefinition" d ON d."id" = r."definitionId"
      JOIN "commerce"."CommerceTranslationModelConfiguration" m ON m."id" = r."translationModelConfigurationId"
      WHERE r."id" = ${runId}
    `);
    return rows[0] ?? null;
  }

  assertRunSnapshot(run: TemplateRunRecord): TemplateSourceSnapshot {
    if (run.sourceHash !== run.definitionSourceHash) throw new Error("STALE_TEMPLATE_DEFINITION_HASH");
    return parseTemplateTranslationSnapshot(run.sourceSnapshot, {
      definitionId: run.definitionId, sourceHash: run.sourceHash,
      sourceLanguageTag: run.sourceLanguageTag,
      sourceSchemaVersion: run.sourceSchemaVersion,
    });
  }

  /** One row-locked run protects the entire item-to-Batch assignment. */
  async assemble(runId: string, limit: number): Promise<{ batchId: string; itemCount: number } | null> {
    return this.db.$transaction(async (tx) => {
      const runs = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
        SELECT "status" FROM "whatsapp"."WhatsAppTemplateTranslationRun"
        WHERE "id" = ${runId} FOR UPDATE
      `);
      if (!runs[0] || !["PENDING", "PROCESSING"].includes(runs[0].status)) return null;
      const run = await this.loadRunForTransaction(tx, runId);
      if (!run) throw new Error("TEMPLATE_RUN_NOT_FOUND");
      this.assertRunSnapshot(run);
      const changed = await tx.$executeRaw(Prisma.sql`
        UPDATE "whatsapp"."WhatsAppTemplateTranslationRun"
        SET "status" = 'PROCESSING', "startedAt" = COALESCE("startedAt", NOW()), "updatedAt" = NOW()
        WHERE "id" = ${runId} AND "status" IN ('PENDING', 'PROCESSING')
      `);
      if (changed !== 1) throw new Error("TEMPLATE_RUN_CLAIM_RACE");
      const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "whatsapp"."WhatsAppTemplateTranslationItem"
        WHERE "runId" = ${runId} AND "status" = 'PENDING' AND "currentBatchId" IS NULL
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW())
        ORDER BY "createdAt", "id" FOR UPDATE SKIP LOCKED LIMIT ${Math.min(100, Math.max(1, limit))}
      `);
      if (candidates.length === 0) {
        await this.advanceRun(tx, runId);
        return null;
      }
      const batchId = randomUUID();
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "whatsapp"."WhatsAppTemplateTranslationBatch"
          ("id", "runId", "provider", "model", "status", "updatedAt")
        VALUES (${batchId}, ${runId}, ${run.provider}, ${run.providerModelId}, 'READY', NOW())
      `);
      for (const candidate of candidates) {
        // Provider identity bounded to 255 chars even when source IDs are unbounded.
        const providerCustomId = `wt-${createHash("sha256").update(candidate.id + ":" + batchId).digest("hex")}`;
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "whatsapp"."WhatsAppTemplateTranslationBatchItem"
            ("id", "batchId", "translationItemId", "providerCustomId")
          VALUES (${randomUUID()}, ${batchId}, ${candidate.id}, ${providerCustomId})
        `);
        const updated = await tx.$executeRaw(Prisma.sql`
          UPDATE "whatsapp"."WhatsAppTemplateTranslationItem"
          SET "currentBatchId" = ${batchId}, "updatedAt" = NOW()
          WHERE "id" = ${candidate.id} AND "status" = 'PENDING' AND "currentBatchId" IS NULL
        `);
        if (updated !== 1) throw new Error("TEMPLATE_ITEM_ASSIGNMENT_RACE");
      }
      return { batchId, itemCount: candidates.length };
    });
  }

  private async loadRunForTransaction(tx: SqlTransaction, runId: string): Promise<TemplateRunRecord | null> {
    const rows = await tx.$queryRaw<TemplateRunRecord[]>(Prisma.sql`
      SELECT r."id", r."definitionId", r."status", r."sourceHash", r."sourceSchemaVersion",
        r."sourceSnapshot", d."sourceHash" AS "definitionSourceHash",
        d."sourceLanguageTag", r."provider", r."providerModelId", m."environment"::text AS "environment"
      FROM "whatsapp"."WhatsAppTemplateTranslationRun" r
      JOIN "whatsapp"."WhatsAppTemplateDefinition" d ON d."id" = r."definitionId"
      JOIN "commerce"."CommerceTranslationModelConfiguration" m ON m."id" = r."translationModelConfigurationId"
      WHERE r."id" = ${runId}
    `);
    return rows[0] ?? null;
  }

  async loadBatch(batchId: string): Promise<TemplateBatchRecord | null> {
    const rows = await this.db.$queryRaw<TemplateBatchRecord[]>(Prisma.sql`
      SELECT r."id", r."definitionId", r."status", r."sourceHash", r."sourceSchemaVersion",
        r."sourceSnapshot", d."sourceHash" AS "definitionSourceHash", d."sourceLanguageTag",
        r."provider", r."providerModelId", m."environment"::text AS "environment",
        b."id" AS "batchId", b."status" AS "batchStatus", b."providerBatchId",
        b."inputFileId", b."outputFileId", b."errorFileId", b."pollSequence",
        b."submitAttemptCount", b."submittedAt", b."submissionStartedAt"
      FROM "whatsapp"."WhatsAppTemplateTranslationBatch" b
      JOIN "whatsapp"."WhatsAppTemplateTranslationRun" r ON r."id" = b."runId"
      JOIN "whatsapp"."WhatsAppTemplateDefinition" d ON d."id" = r."definitionId"
      JOIN "commerce"."CommerceTranslationModelConfiguration" m ON m."id" = r."translationModelConfigurationId"
      WHERE b."id" = ${batchId}
    `);
    return rows[0] ?? null;
  }

  async claimReadyBatch(batchId: string): Promise<TemplateBatchRecord | null> {
    const changed = await this.db.$executeRaw(Prisma.sql`
      UPDATE "whatsapp"."WhatsAppTemplateTranslationBatch" b
      SET "status" = 'SUBMITTING', "submissionStartedAt" = NOW(),
        "lastSubmitAttemptAt" = NOW(), "submitAttemptCount" = "submitAttemptCount" + 1,
        "updatedAt" = NOW()
      FROM "whatsapp"."WhatsAppTemplateTranslationRun" r
      WHERE b."id" = ${batchId} AND b."runId" = r."id"
        AND r."status" = 'PROCESSING' AND b."status" = 'READY'
        AND (b."nextSubmitAt" IS NULL OR b."nextSubmitAt" <= NOW())
    `);
    return changed === 1 ? this.loadBatch(batchId) : null;
  }

  async members(batchId: string): Promise<ItemMembership[]> {
    return this.db.$queryRaw<ItemMembership[]>(Prisma.sql`
      SELECT i."translationItemId", i."providerCustomId", t."targetLanguageTag",
        t."currentBatchId", t."status", t."retryCount"
      FROM "whatsapp"."WhatsAppTemplateTranslationBatchItem" i
      JOIN "whatsapp"."WhatsAppTemplateTranslationItem" t ON t."id" = i."translationItemId"
      WHERE i."batchId" = ${batchId} ORDER BY i."createdAt", i."id"
    `);
  }

  async persistInputFileId(batchId: string, fileId: string): Promise<void> {
    const count = await this.db.$executeRaw(Prisma.sql`
      UPDATE "whatsapp"."WhatsAppTemplateTranslationBatch"
      SET "inputFileId" = ${fileId}, "updatedAt" = NOW()
      WHERE "id" = ${batchId} AND "status" = 'SUBMITTING'
    `);
    if (count !== 1) throw new Error("STALE_TEMPLATE_BATCH_INPUT_WRITE");
  }

  async persistSubmitted(batchId: string, providerBatchId: string, inputFileId: string, pollSeconds: number): Promise<void> {
    const count = await this.db.$executeRaw(Prisma.sql`
      UPDATE "whatsapp"."WhatsAppTemplateTranslationBatch"
      SET "status" = 'SUBMITTED', "providerBatchId" = ${providerBatchId},
        "inputFileId" = ${inputFileId}, "submittedAt" = NOW(), "pollSequence" = 1,
        "nextPollAt" = NOW() + (${pollSeconds} * INTERVAL '1 second'),
        "failureCode" = NULL, "updatedAt" = NOW()
      WHERE "id" = ${batchId} AND "status" = 'SUBMITTING'
    `);
    if (count !== 1) throw Object.assign(new Error("AMBIGUOUS_TEMPLATE_BATCH_ACCEPTANCE"), { classification: "AMBIGUOUS_CREATE" });
  }

  async advanceRun(tx: SqlTransaction, runId: string): Promise<"processing" | "completed" | "failed"> {
    const counts = await tx.$queryRaw<Array<{ total: bigint; available: bigint; failed: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "total", COUNT(*) FILTER (WHERE "status" = 'AVAILABLE')::bigint AS "available",
        COUNT(*) FILTER (WHERE "status" = 'FAILED')::bigint AS "failed"
      FROM "whatsapp"."WhatsAppTemplateTranslationItem" WHERE "runId" = ${runId}
    `);
    const { total, available, failed } = counts[0] ?? { total: 0n, available: 0n, failed: 0n };
    // Empty runs are poisoned inputs, not perpetual PROCESSING rows.
    // Do not publish/Admin-finalise here. Only report keyed results ready.
    const outcome = total === 0n || failed > 0n ? "failed" : available === total ? "completed" : "processing";
    if (outcome !== "processing") {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "whatsapp"."WhatsAppTemplateTranslationRun"
        SET "status" = ${outcome === "completed" ? "COMPLETED" : "FAILED"},
          "failureCode" = ${outcome === "failed" ? total === 0n ? "TRANSLATION_ITEMS_MISSING" : "TRANSLATION_ITEM_FAILED" : null},
          "completedAt" = NOW(), "updatedAt" = NOW()
        WHERE "id" = ${runId} AND "status" = 'PROCESSING'
      `);
    }
    return outcome;
  }

  async advanceRunState(runId: string): Promise<"processing" | "completed" | "failed"> {
    return this.db.$transaction((tx) => this.advanceRun(tx, runId));
  }

  async setResult(input: {
    batchId: string; providerCustomId: string; translated: KeyedTranslationResult | null;
    failureCode: string | null; maxRetries: number; retrySeconds: number;
  }): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<ItemMembership[]>(Prisma.sql`
        SELECT i."translationItemId", i."providerCustomId", t."targetLanguageTag",
          t."currentBatchId", t."status", t."retryCount"
        FROM "whatsapp"."WhatsAppTemplateTranslationBatchItem" i
        JOIN "whatsapp"."WhatsAppTemplateTranslationItem" t ON t."id" = i."translationItemId"
        WHERE i."batchId" = ${input.batchId} AND i."providerCustomId" = ${input.providerCustomId}
        FOR UPDATE OF t
      `);
      const item = rows[0];
      if (!item) throw new Error("UNKNOWN_PROVIDER_TEMPLATE_ITEM");
      if (item.currentBatchId !== input.batchId || item.status !== "PENDING") return false;
      if (input.translated) {
        const json = JSON.stringify(input.translated);
        const hash = templateTranslationContentHash(input.translated);
        await tx.$executeRaw(Prisma.sql`
          UPDATE "whatsapp"."WhatsAppTemplateTranslationItem"
          SET "translatedAst" = ${json}::jsonb, "outputContentHash" = ${hash},
            "status" = 'AVAILABLE', "currentBatchId" = NULL,
            "failureCode" = NULL, "nextAttemptAt" = NULL,
            "completedAt" = NOW(), "updatedAt" = NOW()
          WHERE "id" = ${item.translationItemId} AND "currentBatchId" = ${input.batchId}
        `);
        return true;
      }
      const code = (input.failureCode ?? "TRANSLATION_PROVIDER_FAILED").slice(0, 128);
      const retry = translationItemRetryDisposition({
        failureCode: code, retryCount: item.retryCount,
        maxAutoRetries: input.maxRetries, retryDelaySeconds: input.retrySeconds,
      });
      await tx.$executeRaw(Prisma.sql`
        UPDATE "whatsapp"."WhatsAppTemplateTranslationItem"
        SET "status" = ${retry.status}, "currentBatchId" = NULL,
          "failureCode" = ${code}, "retryCount" = "retryCount" + ${retry.retryIncrement},
          "nextAttemptAt" = ${retry.nextAttemptAt}, "updatedAt" = NOW()
        WHERE "id" = ${item.translationItemId} AND "currentBatchId" = ${input.batchId}
      `);
      return true;
    });
  }

  async markBatchTerminal(batch: TemplateBatchRecord, failureCode: string, retry: { maxRetries: number; retrySeconds: number }): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const count = await tx.$executeRaw(Prisma.sql`
        UPDATE "whatsapp"."WhatsAppTemplateTranslationBatch"
        SET "status" = 'FAILED', "failureCode" = ${failureCode.slice(0, 128)},
          "nextPollAt" = NULL, "nextSubmitAt" = NULL, "completedAt" = NOW(), "updatedAt" = NOW()
        WHERE "id" = ${batch.batchId} AND "status" IN ('SUBMITTING', 'SUBMISSION_UNKNOWN', 'SUBMITTED', 'PROVIDER_COMPLETED')
      `);
      if (!count) return;
      const items = await tx.$queryRaw<Array<{ id: string; retryCount: number }>>(Prisma.sql`
        SELECT "id", "retryCount" FROM "whatsapp"."WhatsAppTemplateTranslationItem"
        WHERE "currentBatchId" = ${batch.batchId} AND "status" = 'PENDING' FOR UPDATE
      `);
      for (const item of items) {
        const disposition = translationItemRetryDisposition({
          failureCode, retryCount: item.retryCount,
          maxAutoRetries: retry.maxRetries, retryDelaySeconds: retry.retrySeconds,
        });
        await tx.$executeRaw(Prisma.sql`
          UPDATE "whatsapp"."WhatsAppTemplateTranslationItem"
          SET "status" = ${disposition.status}, "retryCount" = "retryCount" + ${disposition.retryIncrement},
            "currentBatchId" = NULL, "failureCode" = ${failureCode.slice(0, 128)},
            "nextAttemptAt" = ${disposition.nextAttemptAt}, "updatedAt" = NOW()
          WHERE "id" = ${item.id} AND "currentBatchId" = ${batch.batchId}
        `);
      }
      await this.advanceRun(tx, batch.id);
    });
  }

  async finishBatch(batchId: string, runId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const count = await tx.$executeRaw(Prisma.sql`
        UPDATE "whatsapp"."WhatsAppTemplateTranslationBatch"
        SET "status" = 'COMPLETED', "completedAt" = NOW(), "updatedAt" = NOW()
        WHERE "id" = ${batchId} AND "status" = 'PROVIDER_COMPLETED'
      `);
      if (count) await this.advanceRun(tx, runId);
    });
  }
}
