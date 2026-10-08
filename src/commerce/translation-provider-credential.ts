import type { PrismaClient } from "@prisma/client";
import {
  createCommerceTranslationProviderCredentialAad,
  type CommerceEnvironment,
} from "@modainteract/moda-interact-shared/commerce/model";
import { decryptEncryptedCredential } from "../security/aes-gcm-credential.js";

const UNAVAILABLE = "Translation provider credential is unavailable";

export type TranslationProviderCredentialResolver = {
  resolve(input: {
    environment: CommerceEnvironment;
    provider: string;
    signal?: AbortSignal;
  }): Promise<string>;
};

export function createTranslationProviderCredentialResolver(input: {
  db: PrismaClient;
  keyring: Readonly<Record<string, Uint8Array>>;
}): TranslationProviderCredentialResolver {
  return {
    async resolve({ environment, provider, signal }): Promise<string> {
      if (signal?.aborted) throw new Error(UNAVAILABLE);
      try {
        const normalizedProvider = provider.trim().toLowerCase();
        if (!normalizedProvider || normalizedProvider.length > 64) {
          throw new Error(UNAVAILABLE);
        }
        const row = await input.db.commerceTranslationProviderCredential.findUnique({
          where: {
            environment_provider: {
              environment,
              provider: normalizedProvider,
            },
          },
        });
        if (
          signal?.aborted ||
          !row ||
          row.environment !== environment ||
          row.provider !== normalizedProvider
        ) {
          throw new Error(UNAVAILABLE);
        }

        const credential = decryptEncryptedCredential({
          envelope: row,
          key: input.keyring[row.keyId],
          aad: createCommerceTranslationProviderCredentialAad({
            environment,
            provider: normalizedProvider,
            keyId: row.keyId,
          }),
        });
        if (signal?.aborted) throw new Error(UNAVAILABLE);
        return credential;
      } catch {
        throw new Error(UNAVAILABLE);
      }
    },
  };
}
