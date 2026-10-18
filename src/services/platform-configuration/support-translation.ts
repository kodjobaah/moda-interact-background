/** Support translation's credential comes from Commerce's existing domain rows, not ai.providers. */
import prisma from "../../lib/db.js";
import { resolveCommerceEnvironment } from "../../commerce/model-environment.js";
import { createTranslationProviderCredentialResolver } from "../../commerce/translation-provider-credential.js";
import { readCommerceKeyring } from "./consumers.js";

export async function readSupportTranslationCredential(provider: string): Promise<string> {
  const resolver = createTranslationProviderCredentialResolver({ db: prisma, keyring: await readCommerceKeyring() });
  return resolver.resolve({ environment: resolveCommerceEnvironment(), provider });
}
