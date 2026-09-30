import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import type {
  AcquiredMerchantKnowledgeDocument,
  MerchantKnowledgeUploadedAssetAcquirer,
} from "./merchant-knowledge-acquisition.js";
import { extractMerchantKnowledgeCsv } from "./merchant-knowledge-csv-extraction.js";
import { extractMerchantKnowledgeXlsx } from "./merchant-knowledge-xlsx-extraction.js";
import type { MerchantKnowledgeR2Client } from "./merchant-knowledge-r2-client.js";

export class MerchantKnowledgeUploadedAssetAcquisitionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MerchantKnowledgeUploadedAssetAcquisitionError";
  }
}


interface UploadedAssetAcquirerDependencies {
  database: Pick<PrismaClient, "merchantKnowledgeUploadedAsset">;
  r2: MerchantKnowledgeR2Client;
  bucket: string;
  maxUploadBytes: number;
  maxXlsxUncompressedBytes: number;
}

export class MerchantKnowledgeUploadedAssetAcquirerService
implements MerchantKnowledgeUploadedAssetAcquirer {
  constructor(private readonly dependencies: UploadedAssetAcquirerDependencies) {}

  async acquire(input: {
    shopId: string;
    assetId: string;
    dataFormatKey: "CSV" | "XLSX";
  }): Promise<AcquiredMerchantKnowledgeDocument> {
    const asset = await this.dependencies.database.merchantKnowledgeUploadedAsset.findUnique({
      where: { id: input.assetId },
      select: {
        id: true,
        shopId: true,
        status: true,
        objectKey: true,
        originalFileName: true,
        contentType: true,
        sizeBytes: true,
        sha256: true,
        dataFormat: { select: { key: true, inputKind: true } },
      },
    });

    if (!asset || asset.shopId !== input.shopId) {
      throw new MerchantKnowledgeUploadedAssetAcquisitionError("ASSET_NOT_FOUND");
    }
    if (
      asset.status !== "AVAILABLE"
      || asset.dataFormat.key !== input.dataFormatKey
      || asset.dataFormat.inputKind !== "UPLOAD"
    ) {
      throw new MerchantKnowledgeUploadedAssetAcquisitionError("ASSET_NOT_ACQUIRABLE");
    }
    if (
      !asset.sizeBytes
      || asset.sizeBytes <= 0n
      || !asset.sha256
      || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || !asset.contentType?.trim()
      || !Number.isSafeInteger(this.dependencies.maxUploadBytes)
      || this.dependencies.maxUploadBytes <= 0
    ) {
      throw new MerchantKnowledgeUploadedAssetAcquisitionError("INVALID_ASSET_METADATA");
    }
    if (asset.sizeBytes > BigInt(this.dependencies.maxUploadBytes)) {
      throw new MerchantKnowledgeUploadedAssetAcquisitionError("UPLOAD_TOO_LARGE");
    }

    let body: AsyncIterable<Uint8Array>;
    try {
      body = await this.dependencies.r2.getObject({
        bucket: this.dependencies.bucket,
        key: asset.objectKey,
      });
    } catch {
      throw new MerchantKnowledgeUploadedAssetAcquisitionError("R2_READ_FAILED");
    }

    const chunks: Uint8Array[] = [];
    const hash = createHash("sha256");
    let actualSize = 0;
    try {
      for await (const chunk of body) {
        if (!(chunk instanceof Uint8Array)) {
          throw new MerchantKnowledgeUploadedAssetAcquisitionError("INVALID_R2_BODY");
        }
        if (actualSize > this.dependencies.maxUploadBytes - chunk.byteLength) {
          const destroyable = body as AsyncIterable<Uint8Array> & { destroy?: () => void };
          destroyable.destroy?.();
          throw new MerchantKnowledgeUploadedAssetAcquisitionError("UPLOAD_TOO_LARGE");
        }
        actualSize += chunk.byteLength;
        hash.update(chunk);
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof MerchantKnowledgeUploadedAssetAcquisitionError) throw error;
      throw new MerchantKnowledgeUploadedAssetAcquisitionError("R2_READ_FAILED");
    }

    if (
      BigInt(actualSize) !== asset.sizeBytes
      || hash.digest("hex") !== asset.sha256
    ) {
      throw new MerchantKnowledgeUploadedAssetAcquisitionError("ASSET_INTEGRITY_MISMATCH");
    }

    const bytes = Buffer.concat(chunks, actualSize);
    let extractedText: string;
    try {
      extractedText = input.dataFormatKey === "CSV"
        ? extractMerchantKnowledgeCsv(asset.originalFileName, bytes)
        : await extractMerchantKnowledgeXlsx(
          asset.originalFileName,
          bytes,
          this.dependencies.maxXlsxUncompressedBytes,
        );
    } catch (error) {
      if (error instanceof Error && "code" in error && typeof error.code === "string") {
        throw new MerchantKnowledgeUploadedAssetAcquisitionError(error.code);
      }
      throw new MerchantKnowledgeUploadedAssetAcquisitionError("ASSET_EXTRACTION_FAILED");
    }

    return {
      contentType: asset.contentType,
      extractedText,
      resolvedUrl: null,
      fetchedAt: null,
    };
  }
}