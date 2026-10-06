import OpenAI from "openai";

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
