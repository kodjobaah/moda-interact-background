import { Prisma, type PrismaClient } from "@prisma/client";

import type { MerchantKnowledgeR2Client } from "./merchant-knowledge-r2-client.js";

const PAGE_SIZE = 100;
const AVAILABLE_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

type CleanupDatabase = Pick<
  PrismaClient,
  "$transaction" | "merchantKnowledgeUploadedAsset"
>;

interface CleanupDependencies {
  database: CleanupDatabase;
  r2: Pick<MerchantKnowledgeR2Client, "deleteObject">;
  bucket: string;
  now?: () => Date;
}

interface Candidate {
  id: string;
  status: "PENDING_UPLOAD" | "AVAILABLE" | "DELETED";
}

export interface MerchantKnowledgeUploadCleanupResult {
  scanned: number;
  tombstoned: number;
  deleted: number;
  deleteFailed: number;
  skipped: number;
}

export class MerchantKnowledgeUploadCleanupService {
  constructor(private readonly dependencies: CleanupDependencies) {}

  async cleanupOnce(): Promise<MerchantKnowledgeUploadCleanupResult> {
    const now = this.dependencies.now?.() ?? new Date();
    const orphanBefore = new Date(now.getTime() - AVAILABLE_ORPHAN_GRACE_MS);
    const candidates = await this.dependencies.database.merchantKnowledgeUploadedAsset.findMany({
      where: {
        OR: [
          { status: "PENDING_UPLOAD", uploadExpiresAt: { lt: now } },
          {
            status: "AVAILABLE",
            createdAt: { lt: orphanBefore },
            revisions: { none: {} },
          },
          { status: "DELETED" },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: PAGE_SIZE,
      select: { id: true, status: true },
    }) as Candidate[];

    const result: MerchantKnowledgeUploadCleanupResult = {
      scanned: candidates.length,
      tombstoned: 0,
      deleted: 0,
      deleteFailed: 0,
      skipped: 0,
    };

    for (const candidate of candidates) {
      const objectKey = await this.dependencies.database.$transaction(async (transaction) => {
        const locked = await transaction.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
          SELECT "id", "status"::text AS "status"
          FROM "commerce"."MerchantKnowledgeUploadedAsset"
          WHERE "id" = ${candidate.id}
          FOR UPDATE
        `);
        const row = locked[0];
        if (!row) return null;

        const revisionCount = await transaction.merchantKnowledgeSourceRevision.count({
          where: { uploadedAssetId: candidate.id },
        });
        if (revisionCount > 0) return null;

        if (row.status === "DELETED") {
          const deletedAsset = await transaction.merchantKnowledgeUploadedAsset.findUnique({
            where: { id: candidate.id },
            select: { objectKey: true },
          });
          return deletedAsset?.objectKey ?? null;
        }

        let failureCode: string;
        if (row.status === "PENDING_UPLOAD") {
          const pending = await transaction.merchantKnowledgeUploadedAsset.findFirst({
            where: { id: candidate.id, status: "PENDING_UPLOAD", uploadExpiresAt: { lt: now } },
            select: { objectKey: true },
          });
          if (!pending) return null;
          failureCode = "UPLOAD_EXPIRED";
          await transaction.merchantKnowledgeUploadedAsset.update({
            where: { id: candidate.id },
            data: { status: "DELETED", failureCode },
          });
          result.tombstoned += 1;
          return pending.objectKey;
        }

        if (row.status === "AVAILABLE") {
          const available = await transaction.merchantKnowledgeUploadedAsset.findFirst({
            where: { id: candidate.id, status: "AVAILABLE", createdAt: { lt: orphanBefore } },
            select: { objectKey: true },
          });
          if (!available) return null;
          failureCode = "UNREFERENCED_ASSET";
          await transaction.merchantKnowledgeUploadedAsset.update({
            where: { id: candidate.id },
            data: { status: "DELETED", failureCode },
          });
          result.tombstoned += 1;
          return available.objectKey;
        }

        return null;
      });

      if (!objectKey) {
        result.skipped += 1;
        continue;
      }

      try {
        await this.dependencies.r2.deleteObject({ bucket: this.dependencies.bucket, key: objectKey });
        result.deleted += 1;
      } catch {
        result.deleteFailed += 1;
      }
    }

    return result;
  }
}
