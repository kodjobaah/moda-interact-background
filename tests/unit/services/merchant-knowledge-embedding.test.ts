import { createCipheriv } from "node:crypto";

import { CommerceEmbeddingPurpose } from "@prisma/client";
import { canonicalJson } from "@modainteract/moda-interact-shared/commerce";
import { describe, expect, it, vi } from "vitest";

import {
  MerchantKnowledgeEmbeddingConfigurationError,
  MerchantKnowledgeEmbeddingError,
  MerchantKnowledgeEmbeddingService,
} from "../../../src/services/merchant-knowledge-embedding.js";
import { createMerchantKnowledgeEmbeddingResolver } from "../../../src/services/merchant-knowledge-embedding-runtime.js";

const config = {
  provider: "openai" as const,
  model: "text-embedding-test",
  dimensions: 3,
  indexVersion: "v1",
  apiKey: "secret",
};

function sealedRow(overrides: Record<string, unknown> = {}) {
  const environment = "TEST" as const;
  const purpose = CommerceEmbeddingPurpose.MERCHANT_KNOWLEDGE;
  const provider = "openai";
  const keyId = "active";
  const key = Buffer.alloc(32, 7);
  const nonce = Buffer.alloc(12, 9);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(canonicalJson({
    credentialType: "EMBEDDING",
    environment,
    purpose,
    provider,
    keyId,
  }), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from("db-secret", "utf8")),
    cipher.final(),
  ]);
  return {
    key,
    row: {
      id: "embedding-config-1",
      environment,
      purpose,
      embeddingProvider: provider,
      embeddingModel: " text-embedding-test ",
      embeddingDimensions: 3,
      embeddingIndexVersion: " v1 ",
      ciphertext,
      nonce,
      authTag: cipher.getAuthTag(),
      keyId,
      editVersion: 2,
      updatedByAdminId: "admin-1",
      createdAt: new Date("2026-10-05T00:00:00.000Z"),
      updatedAt: new Date("2026-10-05T00:00:00.000Z"),
      ...overrides,
    },
  };
}

describe("Merchant Knowledge database-backed embedding configuration", () => {
  it("resolves the current environment/purpose row and decrypts the stored credential", async () => {
    const { key, row } = sealedRow();
    const findUnique = vi.fn().mockResolvedValue(row);
    const resolver = createMerchantKnowledgeEmbeddingResolver({
      db: { commerceEmbeddingConfiguration: { findUnique } } as never,
      environment: "TEST",
      keyring: { active: key },
    });

    const service = await resolver.resolve();

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        environment_purpose: {
          environment: "TEST",
          purpose: CommerceEmbeddingPurpose.MERCHANT_KNOWLEDGE,
        },
      },
    });
    expect(service.config).toEqual({
      provider: "openai",
      model: "text-embedding-test",
      dimensions: 3,
      indexVersion: "v1",
      apiKey: "db-secret",
    });
  });

  it("re-reads the database on every resolution so admin changes are hot-swappable", async () => {
    const first = sealedRow();
    const second = sealedRow({ embeddingModel: "text-embedding-next", editVersion: 3 });
    const findUnique = vi.fn()
      .mockResolvedValueOnce(first.row)
      .mockResolvedValueOnce(second.row);
    const resolver = createMerchantKnowledgeEmbeddingResolver({
      db: { commerceEmbeddingConfiguration: { findUnique } } as never,
      environment: "TEST",
      keyring: { active: first.key },
    });

    await expect(resolver.resolve()).resolves.toMatchObject({
      config: expect.objectContaining({ model: "text-embedding-test" }),
    });
    await expect(resolver.resolve()).resolves.toMatchObject({
      config: expect.objectContaining({ model: "text-embedding-next" }),
    });
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the database configuration is missing or cannot be decrypted", async () => {
    const missing = createMerchantKnowledgeEmbeddingResolver({
      db: { commerceEmbeddingConfiguration: { findUnique: vi.fn().mockResolvedValue(null) } } as never,
      environment: "TEST",
      keyring: { active: Buffer.alloc(32, 1) },
    });
    await expect(missing.resolve()).rejects.toMatchObject({
      code: "EMBEDDING_CONFIGURATION_UNAVAILABLE",
    });

    const { row } = sealedRow();
    const wrongKey = createMerchantKnowledgeEmbeddingResolver({
      db: { commerceEmbeddingConfiguration: { findUnique: vi.fn().mockResolvedValue(row) } } as never,
      environment: "TEST",
      keyring: { active: Buffer.alloc(32, 3) },
    });
    await expect(wrongKey.resolve()).rejects.toBeInstanceOf(
      MerchantKnowledgeEmbeddingConfigurationError,
    );
  });
});

describe("MerchantKnowledgeEmbeddingService", () => {
  it("sends the exact chunk and configured model/dimensions to OpenAI", async () => {
    const create = vi.fn().mockResolvedValue({ data: [{ embedding: [0, 1, -2] }] });
    const service = new MerchantKnowledgeEmbeddingService(
      config,
      { embeddings: { create } },
    );

    await expect(service.embed("exact chunk")).resolves.toEqual([0, 1, -2]);
    expect(create).toHaveBeenCalledWith({
      model: "text-embedding-test",
      input: "exact chunk",
      dimensions: 3,
    });
  });

  it.each([[1, 2], [1, Number.NaN, 3], [1, Number.POSITIVE_INFINITY, 3]])(
    "rejects invalid vectors",
    async (...embedding) => {
      const service = new MerchantKnowledgeEmbeddingService(
        config,
        { embeddings: { create: vi.fn().mockResolvedValue({ data: [{ embedding }] }) } },
      );
      await expect(service.embed("chunk")).rejects.toMatchObject({
        code: "EMBEDDING_VECTOR_INVALID",
        retryable: false,
      });
    },
  );

  it("maps provider availability errors to a bounded retryable failure", async () => {
    const service = new MerchantKnowledgeEmbeddingService(
      config,
      { embeddings: { create: vi.fn().mockRejectedValue({ status: 503 }) } },
    );
    await expect(service.embed("chunk")).rejects.toBeInstanceOf(
      MerchantKnowledgeEmbeddingError,
    );
    await expect(service.embed("chunk")).rejects.toMatchObject({
      code: "EMBEDDING_PROVIDER_TEMPORARY",
      retryable: true,
    });
  });
});
