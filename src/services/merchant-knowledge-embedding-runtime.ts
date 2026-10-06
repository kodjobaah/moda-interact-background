import { createDecipheriv } from "node:crypto";

import {
  CommerceEmbeddingPurpose,
  type CommerceEnvironment,
  type PrismaClient,
} from "@prisma/client";
import { canonicalJson } from "@modainteract/moda-interact-shared/commerce";

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
        || !row.keyId.trim()
        || row.keyId.length > 64
        || !Number.isSafeInteger(row.editVersion)
        || row.editVersion < 1
        || !(row.ciphertext instanceof Uint8Array)
        || row.ciphertext.byteLength < 1
        || row.ciphertext.byteLength > 8192
        || !(row.nonce instanceof Uint8Array)
        || row.nonce.byteLength !== 12
        || !(row.authTag instanceof Uint8Array)
        || row.authTag.byteLength !== 16
      ) {
        throw new MerchantKnowledgeEmbeddingConfigurationError(
          "INVALID_EMBEDDING_CONFIGURATION",
        );
      }

      const key = input.keyring[row.keyId];
      if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
        throw new MerchantKnowledgeEmbeddingConfigurationError(
          "EMBEDDING_CONFIGURATION_UNAVAILABLE",
        );
      }

      let apiKey: string;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, row.nonce);
        decipher.setAAD(Buffer.from(canonicalJson({
          credentialType: CREDENTIAL_TYPE,
          environment: input.environment,
          purpose: PURPOSE,
          provider,
          keyId: row.keyId,
        }), "utf8"));
        decipher.setAuthTag(row.authTag);
        const plaintext = Buffer.concat([
          decipher.update(row.ciphertext),
          decipher.final(),
        ]);
        apiKey = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
        const encoded = Buffer.from(apiKey, "utf8");
        if (
          encoded.byteLength < 1
          || encoded.byteLength > 8192
          || apiKey.includes("\r")
          || apiKey.includes("\n")
          || apiKey.includes("\0")
          || !encoded.equals(plaintext)
        ) {
          throw new Error("invalid credential");
        }
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
