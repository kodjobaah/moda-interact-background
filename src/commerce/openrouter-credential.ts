import type { PrismaClient } from "@prisma/client";
import {
  createCommerceOpenRouterCredentialAad,
  type CommerceEnvironment,
} from "@modainteract/moda-interact-shared/commerce/model";
import {
  decryptCredential,
  type CredentialKeyring,
} from "@modainteract/moda-interact-shared/security/credentials/node";
import {
  hasValidPersistedCredentialMetadata,
  isValidProviderCredentialText,
} from "./provider-credential-validation.js";
import { OpenRouterCredentialResolutionFailure } from "./openrouter-credential-failure.js";

export type OpenRouterCredentialResolver = {
  resolve(input: {
    environment: CommerceEnvironment;
    signal: AbortSignal;
  }): Promise<string>;
};

export function createOpenRouterCredentialResolver(input: {
  db: PrismaClient;
  keyring: CredentialKeyring;
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
      if (!hasValidPersistedCredentialMetadata(row))
        throw new OpenRouterCredentialResolutionFailure("CREDENTIAL_ENVELOPE_INVALID");
      if (!input.keyring.hasKey(row.keyId))
        throw new OpenRouterCredentialResolutionFailure("CREDENTIAL_KEY_MISSING");

      let credential: string;
      try {
        credential = decryptCredential({
          keyring: input.keyring,
          envelope: {
            keyId: row.keyId,
            nonce: row.nonce,
            ciphertext: row.ciphertext,
            authTag: row.authTag,
          },
          aad: createCommerceOpenRouterCredentialAad({
            environment,
            keyId: row.keyId,
          }),
        });
        if (!isValidProviderCredentialText(credential)) throw new Error("Invalid provider credential");
      } catch (error) {
        assertCurrent();
        throw new OpenRouterCredentialResolutionFailure("CREDENTIAL_DECRYPTION_FAILED", error);
      }
      assertCurrent();
      return credential;
    },
  };
}
