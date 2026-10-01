import OpenAI from "openai";

import { countMerchantKnowledgeCodePoints } from "./merchant-knowledge-normalization.js";

export interface MerchantKnowledgeEmbeddingConfig {
  provider: "openai";
  model: string;
  dimensions: number;
  indexVersion: string;
  apiKey: string;
}

export class MerchantKnowledgeEmbeddingError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(code);
    this.name = "MerchantKnowledgeEmbeddingError";
  }
}

export class MerchantKnowledgeEmbeddingConfigurationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MerchantKnowledgeEmbeddingConfigurationError";
  }
}

export function loadMerchantKnowledgeEmbeddingConfig(
  environment: NodeJS.ProcessEnv = process.env,
): MerchantKnowledgeEmbeddingConfig {
  const provider = environment.EMBEDDING_PROVIDER?.trim();
  const model = environment.EMBEDDING_MODEL?.trim();
  const dimensionsValue = environment.EMBEDDING_DIMENSIONS?.trim();
  const indexVersion = environment.EMBEDDING_INDEX_VERSION?.trim();
  const apiKey = environment.EMBEDDING_API_KEY?.trim();

  if (provider !== "openai") {
    throw new MerchantKnowledgeEmbeddingConfigurationError(
      "UNSUPPORTED_EMBEDDING_PROVIDER",
    );
  }
  if (!model || !dimensionsValue || !indexVersion || !apiKey) {
    throw new MerchantKnowledgeEmbeddingConfigurationError(
      "INVALID_EMBEDDING_CONFIGURATION",
    );
  }

  const dimensions = Number(dimensionsValue);
  if (
    !Number.isSafeInteger(dimensions)
    || dimensions <= 0
    || countMerchantKnowledgeCodePoints(indexVersion) > 64
  ) {
    throw new MerchantKnowledgeEmbeddingConfigurationError(
      "INVALID_EMBEDDING_CONFIGURATION",
    );
  }

  return { provider: "openai", model, dimensions, indexVersion, apiKey };
}

interface OpenAIEmbeddingClient {
  embeddings: {
    create(input: {
      model: string;
      input: string;
      dimensions: number;
    }): Promise<{ data: Array<{ embedding: number[] }> }>;
  };
}

export class MerchantKnowledgeEmbeddingService {
  private readonly client: OpenAIEmbeddingClient;

  constructor(
    readonly config: MerchantKnowledgeEmbeddingConfig,
    client?: OpenAIEmbeddingClient,
  ) {
    this.client = client ?? new OpenAI({
      apiKey: config.apiKey,
      baseURL: "https://api.openai.com/v1",
      maxRetries: 0,
    });
  }

  async embed(content: string): Promise<number[]> {
    let response: { data: Array<{ embedding: number[] }> };
    try {
      response = await this.client.embeddings.create({
        model: this.config.model,
        input: content,
        dimensions: this.config.dimensions,
      });
    } catch (error) {
      if (error instanceof MerchantKnowledgeEmbeddingError) throw error;
      const status =
        typeof error === "object" && error !== null && "status" in error
          ? error.status
          : undefined;
      const retryable = typeof status !== "number" || status === 429 || status >= 500;
      throw new MerchantKnowledgeEmbeddingError(
        retryable ? "EMBEDDING_PROVIDER_TEMPORARY" : "EMBEDDING_PROVIDER_REJECTED",
        retryable,
      );
    }

    const vector = response.data[0]?.embedding;
    if (
      !Array.isArray(vector)
      || vector.length !== this.config.dimensions
      || !vector.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      throw new MerchantKnowledgeEmbeddingError("EMBEDDING_VECTOR_INVALID", false);
    }
    return vector;
  }
}