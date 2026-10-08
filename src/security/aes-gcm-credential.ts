import { createDecipheriv } from "node:crypto";

const UNAVAILABLE = "Encrypted credential is unavailable";

export type EncryptedCredentialEnvelope = Readonly<{
  keyId: string;
  editVersion: number;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
}>;

/** Validate the persisted envelope without consulting provider-specific configuration. */
export function isValidEncryptedCredentialEnvelope(
  envelope: unknown,
): envelope is EncryptedCredentialEnvelope {
  if (!envelope || typeof envelope !== "object") return false;
  const value = envelope as Record<string, unknown>;
  return (
    typeof value.keyId === "string"
    && Boolean(value.keyId.trim())
    && value.keyId.length <= 64
    && Number.isSafeInteger(value.editVersion)
    && (value.editVersion as number) >= 1
    && value.ciphertext instanceof Uint8Array
    && value.ciphertext.byteLength >= 1
    && value.ciphertext.byteLength <= 8192
    && value.nonce instanceof Uint8Array
    && value.nonce.byteLength === 12
    && value.authTag instanceof Uint8Array
    && value.authTag.byteLength === 16
  );
}

export function isValidEncryptedCredentialKey(key: unknown): key is Uint8Array {
  return key instanceof Uint8Array && key.byteLength === 32;
}

/**
 * Decrypt one bounded AES-256-GCM secret using the caller's exact, domain-bound AAD.
 * Callers retain ownership of row lookup, AAD construction and error mapping.
 */
export function decryptEncryptedCredential(input: {
  envelope: EncryptedCredentialEnvelope;
  key: unknown;
  aad: string;
}): string {
  const { envelope, key, aad } = input;
  if (!isValidEncryptedCredentialEnvelope(envelope) || !isValidEncryptedCredentialKey(key)) {
    throw new Error(UNAVAILABLE);
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(envelope.authTag);
    const plaintext = Buffer.concat([
      decipher.update(envelope.ciphertext),
      decipher.final(),
    ]);
    const credential = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const encoded = Buffer.from(credential, "utf8");
    if (
      encoded.byteLength < 1
      || encoded.byteLength > 8192
      || credential.includes("\r")
      || credential.includes("\n")
      || credential.includes("\0")
      || !encoded.equals(plaintext)
    ) {
      throw new Error(UNAVAILABLE);
    }
    return credential;
  } catch {
    // Never expose cipher, decoding or plaintext details at the helper boundary.
    throw new Error(UNAVAILABLE);
  }
}
