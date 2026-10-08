import {
  CommerceEmbeddingPurpose,
  type CommerceEnvironment,
  type PrismaClient,
} from "@prisma/client";
import { canonicalJson } from "@modainteract/moda-interact-shared/commerce";
import {
  decryptEncryptedCredential,
  isValidEncryptedCredentialEnvelope,
  isValidEncryptedCredentialKey,
} from "../security/aes-gcm-credential.js";

import {
  MerchantKnowledgeEmbeddingConfigurationError,
  MerchantKnowledgeEmbeddingService,
} from "./merchant-knowledge-embedding.js";
import { countMerchantKnowledgeCodePoints } from "./merchant-knowledge-normalization.js";

const PURPOSE = CommerceEmbeddingPurpose.MERCHANT_KNOWLEDGE;
const CREDENTIAL_TYPE = "EMBEDDING";

export type MerchantKnowledgeEmbeddingResolver = {
  resolve(): Promise<MerchantKnowledgeEmbeddingService>;
};

export function createMerchantKnowledgeEmbeddingResolver(input: {
  db: Pick<PrismaClient, "commerceEmbeddingConfiguration">;
  environment: CommerceEnvironment;
  keyring: Readonly<Record<string, Uint8Array>>;
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
        || !isValidEncryptedCredentialEnvelope(row)
      ) {
        throw new MerchantKnowledgeEmbeddingConfigurationError(
          "INVALID_EMBEDDING_CONFIGURATION",
        );
      }

      const key = input.keyring[row.keyId];
      if (!isValidEncryptedCredentialKey(key)) {
        throw new MerchantKnowledgeEmbeddingConfigurationError(
          "EMBEDDING_CONFIGURATION_UNAVAILABLE",
        );
      }

      let apiKey: string;
      try {
        apiKey = decryptEncryptedCredential({
          envelope: row,
          key,
          aad: canonicalJson({
            credentialType: CREDENTIAL_TYPE,
            environment: input.environment,
            purpose: PURPOSE,
            provider,
            keyId: row.keyId,
          }),
        });
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
