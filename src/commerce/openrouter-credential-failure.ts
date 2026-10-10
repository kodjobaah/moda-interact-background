/** Finite, operator-safe reasons for Background credential resolution failures. */
const explanations = {
  CREDENTIAL_SIGNAL_ABORTED: [
    "Credential resolution stopped because its AbortSignal was triggered.",
    "Inspect the runner cancellation and deadline logs to identify why the signal was aborted.",
  ],
  CREDENTIAL_LOOKUP_FAILED: [
    "The credential database lookup failed before a credential record could be read.",
    "Check the database connection and the Commerce credential lookup operation.",
  ],
  CREDENTIAL_NOT_CONFIGURED: [
    "No OpenRouter credential is configured for the selected environment.",
    "Configure an OpenRouter credential for this environment in platform administration.",
  ],
  CREDENTIAL_ENVIRONMENT_MISMATCH: [
    "The returned credential record belongs to a different environment.",
    "Check the environment-scoped credential query and stored credential environment.",
  ],
  CREDENTIAL_ENVELOPE_INVALID: [
    "The stored encrypted credential has an invalid envelope or missing required field.",
    "Inspect the stored credential's metadata and replace the invalid encrypted record.",
  ],
  CREDENTIAL_KEY_MISSING: [
    "The encrypted credential references a key ID absent from the configured keyring.",
    "Restore the named credential key in the server-side Commerce keyring.",
  ],
  CREDENTIAL_KEY_INVALID: [
    "The configured encryption key is not a valid 32-byte AES-256 key.",
    "Correct the server-side credential keyring without logging or disclosing key material.",
  ],
  CREDENTIAL_DECRYPTION_FAILED: [
    "The encrypted-credential helper rejected the stored value during authenticated decoding.",
    "Check the encryption key, authenticated envelope and stored credential; rotate if necessary.",
  ],
  CREDENTIAL_RESOLVER_FAILED: [
    "The configured credential resolver failed unexpectedly.",
    "Inspect the credential resolver implementation and dependency availability.",
  ],
} as const;

export type OpenRouterCredentialFailureReason = keyof typeof explanations;

export class OpenRouterCredentialResolutionFailure extends Error {
  readonly stage = "credential.resolve";
  readonly reasonMessage: string;
  readonly operatorAction: string;

  constructor(readonly reasonCode: OpenRouterCredentialFailureReason, cause?: unknown) {
    super("OpenRouter credential is unavailable", { cause });
    this.name = "OpenRouterCredentialResolutionFailure";
    this.reasonMessage = explanations[reasonCode][0];
    this.operatorAction = explanations[reasonCode][1];
  }
}
