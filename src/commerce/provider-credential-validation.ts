/** Provider-specific persisted metadata; AES-GCM authentication stays exclusively in Shared. */
export function hasValidPersistedCredentialMetadata(value: unknown): value is {
  keyId: string;
  editVersion: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authTag: Uint8Array;
} {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.keyId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(row.keyId)
    && !["__proto__", "constructor", "prototype"].includes(row.keyId)
    && Number.isSafeInteger(row.editVersion) && (row.editVersion as number) >= 1
    && row.nonce instanceof Uint8Array && row.nonce.byteLength === 12
    && row.ciphertext instanceof Uint8Array && row.ciphertext.byteLength >= 1
    && row.ciphertext.byteLength <= 8192
    && row.authTag instanceof Uint8Array && row.authTag.byteLength === 16;
}

/** Existing OpenRouter/translation/embedding provider text contract, not a crypto primitive. */
export function isValidProviderCredentialText(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= 8192
    && !/[\r\n\0]/.test(value);
}
