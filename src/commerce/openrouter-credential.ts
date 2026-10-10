import type { PrismaClient } from "@prisma/client";
import {
  createCommerceOpenRouterCredentialAad,
  type CommerceEnvironment,
} from "@modainteract/moda-interact-shared/commerce/model";
import {
  decryptEncryptedCredential,
  isValidEncryptedCredentialEnvelope,
  isValidEncryptedCredentialKey,
} from "../security/aes-gcm-credential.js";
import { OpenRouterCredentialResolutionFailure } from "./openrouter-credential-failure.js";

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
      const assertCurrent = () => {
        if (signal.aborted)
          throw new OpenRouterCredentialResolutionFailure("CREDENTIAL_SIGNAL_ABORTED");
      };
      assertCurrent();

      const row = await input.db.commerceOpenRouterCredential.findUnique({
        where: { environment },
      }).catch((error: unknown) => {
        assertCurrent();
        throw new OpenRouterCredentialResolutionFailure("CREDENTIAL_LOOKUP_FAILED", error);
      });
      assertCurrent();
      if (!row)
        throw new OpenRouterCredentialResolutionFailure("CREDENTIAL_NOT_CONFIGURED");
      if (row.environment !== environment)
        throw new OpenRouterCredentialResolutionFailure("CREDENTIAL_ENVIRONMENT_MISMATCH");
      if (!isValidEncryptedCredentialEnvelope(row))
        throw new OpenRouterCredentialResolutionFailure("CREDENTIAL_ENVELOPE_INVALID");
      if (!Object.hasOwn(input.keyring, row.keyId))
        throw new OpenRouterCredentialResolutionFailure("CREDENTIAL_KEY_MISSING");
      const key = input.keyring[row.keyId];
      if (!isValidEncryptedCredentialKey(key))
        throw new OpenRouterCredentialResolutionFailure("CREDENTIAL_KEY_INVALID");

      let credential: string;
      try {
        credential = decryptEncryptedCredential({
          envelope: row,
          key,
          aad: createCommerceOpenRouterCredentialAad({
            environment,
            keyId: row.keyId,
          }),
        });
      } catch (error) {
        assertCurrent();
        throw new OpenRouterCredentialResolutionFailure("CREDENTIAL_DECRYPTION_FAILED", error);
      }
      assertCurrent();
      return credential;
    },
  };
}
