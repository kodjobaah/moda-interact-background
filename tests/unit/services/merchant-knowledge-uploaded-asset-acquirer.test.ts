import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { loadMerchantKnowledgeR2Config } from "../../../src/services/merchant-knowledge-r2-config.js";
import {
  MerchantKnowledgeUploadedAssetAcquisitionError,
  MerchantKnowledgeUploadedAssetAcquirerService,
} from "../../../src/services/merchant-knowledge-uploaded-asset-acquirer.js";

const csvBytes = new TextEncoder().encode("Name,Description\nWidget,Useful");
const metadata = {
  id: "private-asset-id",
  shopId: "shop-1",
  status: "AVAILABLE",
  objectKey: "private/shop-1/secret-object-key.csv",
  originalFileName: "catalog.csv",
  contentType: "text/csv",
  sizeBytes: BigInt(csvBytes.byteLength),
  sha256: createHash("sha256").update(csvBytes).digest("hex"),
  dataFormat: { key: "CSV", inputKind: "UPLOAD" },
};

function makeService(options: {
  asset?: typeof metadata | null;
  chunks?: AsyncIterable<Uint8Array>;
  maxUploadBytes?: number;
} = {}) {
  const findUnique = vi.fn().mockResolvedValue(options.asset === undefined ? metadata : options.asset);
  const getObject = vi.fn(async () => {
    if (options.chunks) return options.chunks;
    return (async function* () { yield csvBytes; })();
  });
  const database = { merchantKnowledgeUploadedAsset: { findUnique } };
  const r2 = { getObject, deleteObject: vi.fn() };
  const service = new MerchantKnowledgeUploadedAssetAcquirerService({
    database: database as never,
    r2,
    bucket: "private-bucket",
    maxUploadBytes: options.maxUploadBytes ?? 1024,
    maxXlsxUncompressedBytes: 1024,
  });
  return { service, findUnique, getObject };
}

describe("MerchantKnowledgeUploadedAssetAcquirerService", () => {
  it("validates only the exact private R2 environment names and trims configured values", () => {
    expect(loadMerchantKnowledgeR2Config({
      MERCHANT_KNOWLEDGE_R2_ENDPOINT: " https://account.r2.cloudflarestorage.com ",
      MERCHANT_KNOWLEDGE_R2_BUCKET: " knowledge ",
      MERCHANT_KNOWLEDGE_R2_ACCESS_KEY_ID: " key ",
      MERCHANT_KNOWLEDGE_R2_SECRET_ACCESS_KEY: " secret ",
      MERCHANT_KNOWLEDGE_MAX_UPLOAD_BYTES: " 1024 ",
      MERCHANT_KNOWLEDGE_MAX_XLSX_UNCOMPRESSED_BYTES: "2048",
      AWS_ACCESS_KEY_ID: "must-not-be-used",
    })).toMatchObject({
      endpoint: "https://account.r2.cloudflarestorage.com",
      bucket: "knowledge",
      accessKeyId: "key",
      secretAccessKey: "secret",
      maxUploadBytes: 1024,
      maxXlsxUncompressedBytes: 2048,
    });
    expect(() => loadMerchantKnowledgeR2Config({
      MERCHANT_KNOWLEDGE_R2_ENDPOINT: "http://localhost",
    })).toThrowError(expect.objectContaining({ code: "INVALID_MERCHANT_KNOWLEDGE_R2_ENDPOINT" }));
  });

  it("streams the persisted private object, verifies size and SHA-256, and returns no storage identifiers", async () => {
    const { service, getObject } = makeService();
    await expect(service.acquire({ shopId: "shop-1", assetId: metadata.id, dataFormatKey: "CSV" }))
      .resolves.toEqual({
        contentType: "text/csv",
        extractedText: "Name: Widget\nDescription: Useful",
        resolvedUrl: null,
        fetchedAt: null,
      });
    expect(getObject).toHaveBeenCalledWith({ bucket: "private-bucket", key: metadata.objectKey });
    const serialized = JSON.stringify(await service.acquire({
      shopId: "shop-1",
      assetId: metadata.id,
      dataFormatKey: "CSV",
    }));
    expect(serialized).not.toContain(metadata.objectKey);
    expect(serialized).not.toContain(metadata.id);
  });

  it("rejects cross-shop access before R2 GET", async () => {
    const { service, getObject } = makeService();
    await expect(service.acquire({ shopId: "other-shop", assetId: metadata.id, dataFormatKey: "CSV" }))
      .rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    expect(getObject).not.toHaveBeenCalled();
  });

  it("rejects unavailable, wrong-format, wrong-kind, and incomplete asset metadata before GET", async () => {
    const invalidAssets = [
      { ...metadata, status: "DELETED" },
      { ...metadata, dataFormat: { key: "XLSX", inputKind: "UPLOAD" } },
      { ...metadata, dataFormat: { key: "CSV", inputKind: "WEB_PAGE" } },
      { ...metadata, sizeBytes: 0n },
      { ...metadata, sha256: "not-a-hash" },
      { ...metadata, contentType: " " },
    ];
    for (const asset of invalidAssets) {
      const { service, getObject } = makeService({ asset });
      await expect(service.acquire({ shopId: "shop-1", assetId: metadata.id, dataFormatKey: "CSV" }))
        .rejects.toBeInstanceOf(MerchantKnowledgeUploadedAssetAcquisitionError);
      expect(getObject).not.toHaveBeenCalled();
    }
  });

  it("rejects persisted and streamed objects over the configured byte limit", async () => {
    const persistedTooLarge = makeService({ maxUploadBytes: csvBytes.byteLength - 1 });
    await expect(persistedTooLarge.service.acquire({
      shopId: "shop-1",
      assetId: metadata.id,
      dataFormatKey: "CSV",
    })).rejects.toMatchObject({ code: "UPLOAD_TOO_LARGE" });
    expect(persistedTooLarge.getObject).not.toHaveBeenCalled();

    const largeChunks = (async function* () {
      yield new Uint8Array(10);
      yield new Uint8Array(10);
    })();
    const streamedTooLarge = makeService({ chunks: largeChunks, maxUploadBytes: 10 });
    await expect(streamedTooLarge.service.acquire({
      shopId: "shop-1",
      assetId: metadata.id,
      dataFormatKey: "CSV",
    })).rejects.toMatchObject({ code: "UPLOAD_TOO_LARGE" });
  });

  it("rejects stored size and digest mismatches without exposing object keys", async () => {
    const wrongDigest = makeService({ asset: { ...metadata, sha256: "0".repeat(64) } });
    await expect(wrongDigest.service.acquire({
      shopId: "shop-1",
      assetId: metadata.id,
      dataFormatKey: "CSV",
    })).rejects.toMatchObject({ code: "ASSET_INTEGRITY_MISMATCH" });

    const wrongSize = makeService({ asset: { ...metadata, sizeBytes: metadata.sizeBytes + 1n } });
    await expect(wrongSize.service.acquire({
      shopId: "shop-1",
      assetId: metadata.id,
      dataFormatKey: "CSV",
    })).rejects.toMatchObject({ code: "ASSET_INTEGRITY_MISMATCH" });
    await expect(wrongDigest.service.acquire({
      shopId: "shop-1",
      assetId: metadata.id,
      dataFormatKey: "CSV",
    })).rejects.toThrowError(new RegExp(`^(?!.*${metadata.objectKey})`));
  });
});
