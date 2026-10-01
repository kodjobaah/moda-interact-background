import { createHash, randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import {
  resolveDeploymentEnvironmentName,
} from "@modainteract/moda-interact-shared/observability/node";
import type { MerchantKnowledgeProcessSourceRevisionJob } from "@modainteract/moda-interact-shared/merchant-knowledge";

import prisma from "../lib/db.js";
import type {
  MerchantKnowledgeUploadedAssetAcquirer,
  MerchantKnowledgeWebPageAcquirer,
} from "./merchant-knowledge-acquisition.js";
import {
  chunkMerchantKnowledgeText,
  type MerchantKnowledgeChunkContent,
} from "./merchant-knowledge-chunking.js";
import {
  classifyMerchantKnowledgeProcessingError,
  MerchantKnowledgeProcessingError,
} from "./merchant-knowledge-failures.js";
import type { MerchantKnowledgeEmbeddingService } from "./merchant-knowledge-embedding.js";
import {
  countMerchantKnowledgeCodePoints,
  merchantKnowledgeContentUnits,
  normalizeMerchantKnowledgeText,
} from "./merchant-knowledge-normalization.js";
import {
  merchantKnowledgeEntitlementService,
  type MerchantKnowledgeEntitlementService,
} from "./merchant-knowledge-entitlement.service.js";

type ProcessingDatabase = Pick<
  PrismaClient,
  "$transaction"
  | "merchantKnowledgeSource"
  | "merchantKnowledgeSourceRevision"
  | "merchantKnowledgeChunk"
>;
type EligibilityResolver = Pick<
  MerchantKnowledgeEntitlementService,
  "resolveSourceEligibility"
>;

export interface MerchantKnowledgeProcessingDependencies {
  database?: ProcessingDatabase;
  eligibility?: EligibilityResolver;
  webPageAcquirer: MerchantKnowledgeWebPageAcquirer;
  uploadedAssetAcquirer: MerchantKnowledgeUploadedAssetAcquirer;
  embedding: MerchantKnowledgeEmbeddingService;
  logger?: StructuredLogger;
  now?: () => Date;
}

const logger = createLogger({
  serviceName: "moda-merchant-knowledge-worker",
  environment: resolveDeploymentEnvironmentName(),
});

export class MerchantKnowledgeProcessingService {
  private readonly database: ProcessingDatabase;
  private readonly eligibility: EligibilityResolver;
  private readonly logger: StructuredLogger;
  private readonly now: () => Date;

  constructor(private readonly dependencies: MerchantKnowledgeProcessingDependencies) {
    this.database = dependencies.database ?? prisma;
    this.eligibility = dependencies.eligibility ?? merchantKnowledgeEntitlementService;
    this.logger = dependencies.logger ?? logger;
    this.now = dependencies.now ?? (() => new Date());
  }

  async processJob(job: MerchantKnowledgeProcessSourceRevisionJob): Promise<void> {
    const revision = await this.database.merchantKnowledgeSourceRevision.findUnique({
      where: { id: job.sourceRevisionId },
      select: {
        id: true,
        sourceId: true,
        uploadedAssetId: true,
        generation: true,
        status: true,
        requestedUrl: true,
        source: {
          select: {
            id: true,
            shopId: true,
            currentGeneration: true,
            updatedAt: true,
            purpose: { select: { key: true } },
            dataFormat: { select: { key: true, inputKind: true } },
          },
        },
        uploadedAsset: {
          select: {
            id: true,
            shopId: true,
            dataFormat: { select: { key: true, inputKind: true } },
          },
        },
      },
    });

    if (!revision) {
      this.logOutcome(job.sourceRevisionId, "REVISION_NOT_FOUND");
      return;
    }
    if (
      revision.source.shopId !== job.shopId
      || revision.generation !== job.generation
      || revision.generation !== revision.source.currentGeneration
    ) {
      this.logOutcome(revision.id, "STALE_JOB");
      return;
    }
    if (["ACTIVE", "SUPERSEDED", "FAILED"].includes(revision.status)) {
      this.logOutcome(revision.id, "TERMINAL_NOOP");
      return;
    }
    if (revision.status !== "PENDING" && revision.status !== "PROCESSING") {
      this.logOutcome(revision.id, "INVALID_STATUS_NOOP");
      return;
    }

    const initialEligibility = await this.eligibility.resolveSourceEligibility(
      revision.source.id,
    );
    if (!initialEligibility.globallySupported) {
      await this.markPermanentFailure(
        job,
        "SOURCE_TYPE_UNSUPPORTED",
      );
      return;
    }
    if (!initialEligibility.eligible || !initialEligibility.entitlement) {
      await this.resetPending(job);
      this.logOutcome(revision.id, "DORMANT");
      return;
    }

    const claimWhere = {
      id: revision.id,
      generation: job.generation,
      source: {
        is: { shopId: job.shopId, currentGeneration: job.generation },
      },
    };
    let claim = await this.database.merchantKnowledgeSourceRevision.updateMany({
      where: { ...claimWhere, status: "PENDING" },
      data: { status: "PROCESSING", processingStartedAt: this.now(), failureCode: null },
    });
    if (claim.count === 0 && revision.status === "PROCESSING") {
      claim = await this.database.merchantKnowledgeSourceRevision.updateMany({
        where: { ...claimWhere, status: "PROCESSING" },
        data: { failureCode: null },
      });
    }
    if (claim.count === 0) {
      this.logOutcome(revision.id, "CLAIM_LOST");
      return;
    }

    let acquired;
    let content: string;
    let contentUnits: number;
    let truncated: boolean;
    let contentHash: string;
    let chunks: MerchantKnowledgeChunkContent[];
    const chunkVectors: number[][] = [];
    const maxContentUnits = initialEligibility.entitlement.maxContentUnitsPerSource;
    const maxCodePoints = maxContentUnits * 4;
    try {
      acquired = await this.acquire(revision, job);
      const normalized = normalizeMerchantKnowledgeText(acquired.extractedText);
      const normalizedCodePoints = countMerchantKnowledgeCodePoints(normalized);
      truncated = normalizedCodePoints > maxCodePoints;
      content = truncated ? [...normalized].slice(0, maxCodePoints).join("") : normalized;
      contentUnits = merchantKnowledgeContentUnits(content);
      contentHash = createHash("sha256").update(content, "utf8").digest("hex");
      chunks = chunkMerchantKnowledgeText(content);
      for (const chunk of chunks) {
        const vector = await this.dependencies.embedding.embed(chunk.content);
        this.validateVector(vector);
        chunkVectors.push(vector);
      }
    } catch (error) {
      const processingError = classifyMerchantKnowledgeProcessingError(error);
      if (processingError.retryable) throw processingError;
      await this.markPermanentFailure(job, processingError.failureCode);
      return;
    }

    const currentEligibility = await this.eligibility.resolveSourceEligibility(
      revision.source.id,
    );
    if (
      !currentEligibility.eligible
      || !currentEligibility.entitlement
      || currentEligibility.entitlement.maxContentUnitsPerSource !== maxContentUnits
    ) {
      await this.resetPending(job);
      this.logOutcome(revision.id, "ELIGIBILITY_CHANGED");
      return;
    }

    const promoted = await this.promoteRevision({
      job,
      sourceId: revision.source.id,
      acquired,
      content,
      contentUnits,
      contentHash,
      truncated,
      chunks,
      vectors: chunkVectors,
    });
    this.logOutcome(revision.id, promoted ? "ACTIVE" : "STALE_NOOP");
  }

  async markTerminalFailure(input: {
    job: MerchantKnowledgeProcessSourceRevisionJob;
    failureCode: string;
  }): Promise<void> {
    const result = await this.database.merchantKnowledgeSourceRevision.updateMany({
      where: {
        id: input.job.sourceRevisionId,
        generation: input.job.generation,
        status: "PROCESSING",
        source: {
          is: {
            shopId: input.job.shopId,
            currentGeneration: input.job.generation,
          },
        },
      },
      data: { status: "FAILED", failureCode: "RETRIES_EXHAUSTED", completedAt: this.now() },
    });
    if (result.count > 0) {
      this.logOutcome(input.job.sourceRevisionId, "FAILED", "RETRIES_EXHAUSTED");
    }
  }

  private async acquire(
    revision: {
      requestedUrl: string | null;
      uploadedAssetId: string | null;
      source: { shopId: string; dataFormat: { key: string; inputKind: string } };
    },
    job: MerchantKnowledgeProcessSourceRevisionJob,
  ) {
    const { inputKind, key } = revision.source.dataFormat;
    if (inputKind === "REMOTE_URL") {
      if (key !== "WEB_PAGE" || revision.requestedUrl === null) {
        throw new MerchantKnowledgeProcessingError("LOCATOR_FORMAT_MISMATCH", false);
      }
      return this.dependencies.webPageAcquirer.acquire({
        requestedUrl: revision.requestedUrl,
      });
    }
    if (inputKind === "UPLOAD") {
      if (
        revision.uploadedAssetId === null
        || (key !== "CSV" && key !== "XLSX")
      ) {
        throw new MerchantKnowledgeProcessingError("LOCATOR_FORMAT_MISMATCH", false);
      }
      return this.dependencies.uploadedAssetAcquirer.acquire({
        shopId: job.shopId,
        assetId: revision.uploadedAssetId,
        dataFormatKey: key,
      });
    }
    throw new MerchantKnowledgeProcessingError("LOCATOR_FORMAT_MISMATCH", false);
  }

  private async markPermanentFailure(
    job: MerchantKnowledgeProcessSourceRevisionJob,
    failureCode: string,
  ): Promise<void> {
    const result = await this.database.merchantKnowledgeSourceRevision.updateMany({
      where: {
        id: job.sourceRevisionId,
        generation: job.generation,
        status: { in: ["PENDING", "PROCESSING"] },
        source: {
          is: { shopId: job.shopId, currentGeneration: job.generation },
        },
      },
      data: {
        status: "FAILED",
        failureCode,
        completedAt: this.now(),
      },
    });
    if (result.count > 0) {
      this.logOutcome(job.sourceRevisionId, "FAILED", failureCode);
    }
  }

  private async resetPending(
    job: MerchantKnowledgeProcessSourceRevisionJob,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const reset = await transaction.merchantKnowledgeSourceRevision.updateMany({
        where: {
          id: job.sourceRevisionId,
          generation: job.generation,
          status: { in: ["PENDING", "PROCESSING"] },
          source: {
            is: { shopId: job.shopId, currentGeneration: job.generation },
          },
        },
        data: { status: "PENDING", processingStartedAt: null, failureCode: null },
      });
      if (reset.count > 0) {
        await transaction.merchantKnowledgeChunk.deleteMany({
          where: { revisionId: job.sourceRevisionId },
        });
      }
    });
  }

  private async promoteRevision(input: {
    job: MerchantKnowledgeProcessSourceRevisionJob;
    sourceId: string;
    acquired: { contentType: string; resolvedUrl: string | null; fetchedAt: Date | null };
    content: string;
    contentUnits: number;
    contentHash: string;
    truncated: boolean;
    chunks: MerchantKnowledgeChunkContent[];
    vectors: number[][];
  }): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const source = await transaction.merchantKnowledgeSource.findUnique({
        where: { id: input.sourceId },
        select: { shopId: true, currentGeneration: true, updatedAt: true },
      });
      if (
        !source
        || source.shopId !== input.job.shopId
        || source.currentGeneration !== input.job.generation
      ) {
        return false;
      }

      const lockedSource = await transaction.merchantKnowledgeSource.updateMany({
        where: {
          id: input.sourceId,
          shopId: input.job.shopId,
          currentGeneration: input.job.generation,
          updatedAt: source.updatedAt,
        },
        data: {
          currentGeneration: input.job.generation,
          updatedAt: source.updatedAt,
        },
      });
      if (lockedSource.count !== 1) return false;

      const candidate = await transaction.merchantKnowledgeSourceRevision.findFirst({
        where: {
          id: input.job.sourceRevisionId,
          sourceId: input.sourceId,
          generation: input.job.generation,
          status: "PROCESSING",
        },
        select: { id: true },
      });
      if (!candidate) return false;

      const predecessor = await transaction.merchantKnowledgeSourceRevision.findFirst({
        where: { sourceId: input.sourceId, status: "ACTIVE" },
        select: { id: true },
      });
      await transaction.merchantKnowledgeChunk.deleteMany({
        where: { revisionId: candidate.id },
      });
      const candidateWrite = await transaction.merchantKnowledgeSourceRevision.updateMany({
        where: {
          id: candidate.id,
          sourceId: input.sourceId,
          generation: input.job.generation,
          status: "PROCESSING",
        },
        data: {
          contentType: input.acquired.contentType,
          resolvedUrl: input.acquired.resolvedUrl,
          normalizedContent: input.content,
          contentUnits: input.contentUnits,
          contentHash: input.contentHash,
          truncated: input.truncated,
          fetchedAt: input.acquired.fetchedAt,
          completedAt: this.now(),
          failureCode: null,
        },
      });
      if (candidateWrite.count !== 1) return false;

      for (let index = 0; index < input.chunks.length; index += 1) {
        const chunk = input.chunks[index];
        const vector = input.vectors[index];
        if (!chunk || !vector) continue;
        this.validateVector(vector);
        const vectorLiteral = `[${vector.map((value) => value.toString()).join(",")}]`;
        await transaction.$executeRaw(Prisma.sql`
          INSERT INTO "commerce"."MerchantKnowledgeChunk"
            ("id", "revisionId", "ordinal", "content", "contentUnits", "contentHash",
             "embedding", "embeddingProvider", "embeddingModel", "embeddingDimensions", "embeddingIndexVersion")
          VALUES
            (${randomUUID()}, ${candidate.id}, ${chunk.ordinal}, ${chunk.content}, ${chunk.contentUnits}, ${chunk.contentHash},
             ${vectorLiteral}::vector, ${this.dependencies.embedding.config.provider},
             ${this.dependencies.embedding.config.model}, ${this.dependencies.embedding.config.dimensions},
             ${this.dependencies.embedding.config.indexVersion})
        `);
      }

      if (predecessor) {
        await transaction.merchantKnowledgeSourceRevision.update({
          where: { id: predecessor.id },
          data: { status: "SUPERSEDED" },
        });
      }
      const activated = await transaction.merchantKnowledgeSourceRevision.updateMany({
        where: {
          id: candidate.id,
          sourceId: input.sourceId,
          generation: input.job.generation,
          status: "PROCESSING",
        },
        data: { status: "ACTIVE", completedAt: this.now() },
      });
      if (activated.count !== 1) {
        throw new Error("Merchant Knowledge promotion state changed");
      }
      if (predecessor) {
        await transaction.merchantKnowledgeChunk.deleteMany({
          where: { revisionId: predecessor.id },
        });
      }
      return true;
    });
  }

  private validateVector(vector: number[]): void {
    if (
      vector.length !== this.dependencies.embedding.config.dimensions
      || !vector.every((value) => Number.isFinite(value))
    ) {
      throw new MerchantKnowledgeProcessingError("EMBEDDING_VECTOR_INVALID", false);
    }
  }

  private logOutcome(
    sourceRevisionId: string,
    outcome: string,
    failureCode?: string,
  ): void {
    this.logger.info("merchant_knowledge.revision.outcome", {
      sourceRevisionId,
      outcome,
      ...(failureCode ? { failureCode } : {}),
    });
  }
}