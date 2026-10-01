import { describe, expect, it, vi } from "vitest";

import {
  loadMerchantKnowledgeEmbeddingConfig,
  MerchantKnowledgeEmbeddingConfigurationError,
  MerchantKnowledgeEmbeddingError,
  MerchantKnowledgeEmbeddingService,
} from "../../../src/services/merchant-knowledge-embedding.js";

const validEnvironment = {
  EMBEDDING_PROVIDER: " openai ",
  EMBEDDING_MODEL: " text-embedding-test ",
  EMBEDDING_DIMENSIONS: " 3 ",
  EMBEDDING_INDEX_VERSION: " v1 ",
  EMBEDDING_API_KEY: " secret ",
};

describe("Merchant Knowledge embedding configuration", () => {
  it("trims and validates only the declared embedding settings", () => {
    expect(loadMerchantKnowledgeEmbeddingConfig(validEnvironment)).toEqual({
      provider: "openai",
      model: "text-embedding-test",
      dimensions: 3,
      indexVersion: "v1",
      apiKey: "secret",
    });
  });

  it("rejects unsupported providers with the bounded startup code", () => {
    expect(() => loadMerchantKnowledgeEmbeddingConfig({
      ...validEnvironment,
      EMBEDDING_PROVIDER: "local",
    })).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_EMBEDDING_PROVIDER" }),
    );
  });

  it.each(["0", "-1", "1.5", "9007199254740992", ""]) (
    "rejects invalid dimensions %s",
    (dimensions) => {
      expect(() => loadMerchantKnowledgeEmbeddingConfig({
        ...validEnvironment,
        EMBEDDING_DIMENSIONS: dimensions,
      })).toThrow(MerchantKnowledgeEmbeddingConfigurationError);
    },
  );

  it("rejects an index version longer than 64 code points", () => {
    expect(() => loadMerchantKnowledgeEmbeddingConfig({
      ...validEnvironment,
      EMBEDDING_INDEX_VERSION: "\u{1f9ed}".repeat(65),
    })).toThrow(MerchantKnowledgeEmbeddingConfigurationError);
  });
});

describe("MerchantKnowledgeEmbeddingService", () => {
  it("sends the exact chunk and configured model/dimensions to OpenAI", async () => {
    const create = vi.fn().mockResolvedValue({ data: [{ embedding: [0, 1, -2] }] });
    const service = new MerchantKnowledgeEmbeddingService(
      loadMerchantKnowledgeEmbeddingConfig(validEnvironment),
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
        loadMerchantKnowledgeEmbeddingConfig(validEnvironment),
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
      loadMerchantKnowledgeEmbeddingConfig(validEnvironment),
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