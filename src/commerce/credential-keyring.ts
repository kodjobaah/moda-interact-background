import { parseCredentialKeyring, type CredentialKeyring } from "@modainteract/moda-interact-shared/security/credentials/node";

/** Read the only canonical credential keyring variable; parsing is owned by Shared. */
export function readCommerceCredentialKeyring(): CredentialKeyring {
  try {
    return parseCredentialKeyring(process.env.COMMERCE_CONNECTION_KEYS_JSON);
  } catch {
    throw new Error("Commerce credential keyring is invalid");
  }
}
