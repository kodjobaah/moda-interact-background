import type { PrismaClient } from "@prisma/client";
import {
  createCommerceOpenRouterCredentialAad,
  type CommerceEnvironment,
} from "@modainteract/moda-interact-shared/commerce/model";
import { decryptEncryptedCredential } from "../security/aes-gcm-credential.js";

const UNAVAILABLE = "OpenRouter credential is unavailable";

export type OpenRouterCredentialResolver = {
  resolve(input: {
    environment: CommerceEnvironment;
    signal: AbortSignal;
  }): Promise<string>;
};

export function createOpenRouterCredentialResolver(input: {
  db: PrismaClient;
  keyring: Readonly<Record<string, Uint8Array>>;
}): OpenRouterCredentialResolver {
  return {
    async resolve({ environment, signal }): Promise<string> {
      if (signal.aborted) throw new Error(UNAVAILABLE);
      try {
        const row = await input.db.commerceOpenRouterCredential.findUnique({
          where: { environment },
        });
        if (signal.aborted || !row || row.environment !== environment)
          throw new Error(UNAVAILABLE);

        const credential = decryptEncryptedCredential({
          envelope: row,
          key: input.keyring[row.keyId],
          aad: createCommerceOpenRouterCredentialAad({
            environment,
            keyId: row.keyId,
          }),
        });
        if (signal.aborted) throw new Error(UNAVAILABLE);
        return credential;
      } catch {
        throw new Error(UNAVAILABLE);
      }
    },
  };
}