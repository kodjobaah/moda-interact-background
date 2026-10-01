const CONFIGURATION_ERROR = "Commerce credential keyring is invalid";

export function readCommerceCredentialKeyring(): Readonly<Record<string, Uint8Array>> {
  try {
    const serialized = process.env.COMMERCE_CONNECTION_KEYS_JSON;
    if (!serialized) throw new Error(CONFIGURATION_ERROR);
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(CONFIGURATION_ERROR);

    const keyring: Record<string, Uint8Array> = Object.create(null);
    for (const [keyId, encoded] of Object.entries(parsed)) {
      if (
        !keyId.trim() ||
        keyId.length > 64 ||
        typeof encoded !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
      )
        throw new Error(CONFIGURATION_ERROR);
      const key = Buffer.from(encoded, "base64");
      if (key.byteLength !== 32 || key.toString("base64") !== encoded)
        throw new Error(CONFIGURATION_ERROR);
      keyring[keyId] = key;
    }
    if (Object.keys(keyring).length === 0)
      throw new Error(CONFIGURATION_ERROR);
    return Object.freeze(keyring);
  } catch {
    throw new Error(CONFIGURATION_ERROR);
  }
}