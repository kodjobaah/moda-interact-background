import { parseCredentialKeyring } from "@modainteract/moda-interact-shared/security/credentials/node";

/**
 * Temporary bridge for the pre-ARCH-039 Woo grant decryptor, which still takes
 * raw AES key bytes. Strict keyring validation belongs to Shared; this bridge
 * only decodes the already-validated canonical configuration. Remove in
 * ARCH-039-BACKGROUND-002 when Woo adopts Shared.decryptCredential().
 */
export function readWooCouponLegacyKeyring(): Readonly<Record<string, Uint8Array>> {
  const raw = process.env.COMMERCE_CONNECTION_KEYS_JSON;
  parseCredentialKeyring(raw);

  // Shared has validated JSON shape, duplicate IDs, key IDs, and padded Base64.
  const encoded = JSON.parse(raw as string) as Record<string, string>;
  const keys: Record<string, Uint8Array> = Object.create(null);
  for (const [keyId, value] of Object.entries(encoded)) {
    keys[keyId] = Buffer.from(value, "base64");
  }
  return Object.freeze(keys);
}
