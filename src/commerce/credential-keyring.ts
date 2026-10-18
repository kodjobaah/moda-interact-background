import type { CredentialKeyring } from "@modainteract/moda-interact-shared/security/credentials/node";
import { readCommerceKeyring } from "../services/platform-configuration/consumers.js";

const CONFIGURATION_ERROR = "Commerce credential keyring is invalid";

/** The in-scope credential consumers use this canonical Shared parser only. */
export async function readCanonicalCredentialKeyring(): Promise<CredentialKeyring> {
  try {
    return await readCommerceKeyring();
  } catch {
    throw new Error(CONFIGURATION_ERROR);
  }
}

// Keep the established caller name while exposing only Shared's opaque keyring.
export const readCommerceCredentialKeyring = readCanonicalCredentialKeyring;
