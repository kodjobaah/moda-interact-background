import { parseCredentialKeyring, type CredentialKeyring } from "@modainteract/moda-interact-shared/security/credentials/node";

const CONFIGURATION_ERROR = "Commerce credential keyring is invalid";

/** The in-scope credential consumers use this canonical Shared parser only. */
export function readCanonicalCredentialKeyring(): CredentialKeyring {
  try {
    return parseCredentialKeyring(process.env.COMMERCE_CONNECTION_KEYS_JSON);
  } catch {
    throw new Error(CONFIGURATION_ERROR);
  }
}

// Keep the established caller name while exposing only Shared's opaque keyring.
export const readCommerceCredentialKeyring = readCanonicalCredentialKeyring;
