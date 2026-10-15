import {
  CommerceEmbeddingPurpose,
  type CommerceEnvironment,
  type PrismaClient,
} from "@prisma/client";
import {
  createCommerceEmbeddingCredentialAad,
  decryptCredential,
  type CredentialKeyring,
} from "@modainteract/moda-interact-shared/security/credentials/node";
import {
  hasValidPersistedCredentialMetadata,
  isValidProviderCredentialText,
} from "../commerce/provider-credential-validation.js";

import {
  MerchantKnowledgeEmbeddingConfigurationError,
  MerchantKnowledgeEmbeddingService,
} from "./merchant-knowledge-embedding.js";
import { countMerchantKnowledgeCodePoints } from "./merchant-knowledge-normalization.js";

const PURPOSE = CommerceEmbeddingPurpose.MERCHANT_KNOWLEDGE;

export type MerchantKnowledgeEmbeddingResolver = {
  resolve(): Promise<MerchantKnowledgeEmbeddingService>;
};

export function createMerchantKnowledgeEmbeddingResolver(input: {
  db: Pick<PrismaClient, "commerceEmbeddingConfiguration">;
  environment: CommerceEnvironment;
  keyring: CredentialKeyring;
}): MerchantKnowledgeEmbeddingResolver {
  return {
    async resolve(): Promise<MerchantKnowledgeEmbeddingService> {
      const row = await input.db.commerceEmbeddingConfiguration.findUnique({
        where: {
          environment_purpose: {
            environment: input.environment,
            purpose: PURPOSE,
          },
        },
      });
      if (!row) {
        throw new MerchantKnowledgeEmbeddingConfigurationError(
          "EMBEDDING_CONFIGURATION_UNAVAILABLE",
        );
      }

      const provider = row.embeddingProvider.trim();
      const model = row.embeddingModel.trim();
      const indexVersion = row.embeddingIndexVersion.trim();
      if (provider !== "openai") {
        throw new MerchantKnowledgeEmbeddingConfigurationError(
          "UNSUPPORTED_EMBEDDING_PROVIDER",
        );
      }
      if (
        !model
        || !indexVersion
        || !Number.isSafeInteger(row.embeddingDimensions)
        || row.embeddingDimensions <= 0
        || countMerchantKnowledgeCodePoints(indexVersion) > 64
        || !hasValidPersistedCredentialMetadata(row)
      ) {
        throw new MerchantKnowledgeEmbeddingConfigurationError(
          "INVALID_EMBEDDING_CONFIGURATION",
        );
      }
      if (!input.keyring.hasKey(row.keyId)) {
        throw new MerchantKnowledgeEmbeddingConfigurationError(
          "EMBEDDING_CONFIGURATION_UNAVAILABLE",
        );
      }
      let apiKey: string;
      try {
        apiKey = decryptCredential({
          keyring: input.keyring,
          envelope: {
            keyId: row.keyId,
            nonce: row.nonce,
            ciphertext: row.ciphertext,
            authTag: row.authTag,
          },
          aad: createCommerceEmbeddingCredentialAad({
            environment: input.environment,
            purpose: PURPOSE,
            provider,
            keyId: row.keyId,
          }),
        });
        if (!isValidProviderCredentialText(apiKey)) throw new Error("Invalid provider credential");
      } catch {
        throw new MerchantKnowledgeEmbeddingConfigurationError(
          "EMBEDDING_CONFIGURATION_UNAVAILABLE",
        );
      }

      return new MerchantKnowledgeEmbeddingService({
        provider: "openai",
        model,
        dimensions: row.embeddingDimensions,
        indexVersion,
        apiKey,
      });
    },
  };
}
