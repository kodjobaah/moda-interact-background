import { createDecipheriv } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  createCommerceTranslationProviderCredentialAad,
  type CommerceEnvironment,
} from "@modainteract/moda-interact-shared/commerce/model";

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

        const key = input.keyring[row.keyId];
        if (
          !key ||
          key.byteLength !== 32 ||
          !row.keyId.trim() ||
          row.keyId.length > 64 ||
          !Number.isInteger(row.editVersion) ||
          row.editVersion < 1 ||
          !(row.ciphertext instanceof Uint8Array) ||
          row.ciphertext.byteLength < 1 ||
          row.ciphertext.byteLength > 8192 ||
          !(row.nonce instanceof Uint8Array) ||
          row.nonce.byteLength !== 12 ||
          !(row.authTag instanceof Uint8Array) ||
          row.authTag.byteLength !== 16
        ) {
          throw new Error(UNAVAILABLE);
        }

        const decipher = createDecipheriv("aes-256-gcm", key, row.nonce);
        decipher.setAAD(
          Buffer.from(
            createCommerceTranslationProviderCredentialAad({
              environment,
              provider: normalizedProvider,
              keyId: row.keyId,
            }),
            "utf8",
          ),
        );
        decipher.setAuthTag(row.authTag);
        const plaintext = Buffer.concat([
          decipher.update(row.ciphertext),
          decipher.final(),
        ]);
        const credential = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
        const credentialBytes = Buffer.from(credential, "utf8");
        if (
          credentialBytes.byteLength < 1 ||
          credentialBytes.byteLength > 8192 ||
          credential.includes("\r") ||
          credential.includes("\n") ||
          credential.includes("\0") ||
          !credentialBytes.equals(plaintext)
        ) {
          throw new Error(UNAVAILABLE);
        }
        if (signal?.aborted) throw new Error(UNAVAILABLE);
        return credential;
      } catch {
        throw new Error(UNAVAILABLE);
      }
    },
  };
}
