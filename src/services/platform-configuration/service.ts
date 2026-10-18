import { Buffer } from "node:buffer";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import {
  decryptCredential, parseCredentialKeyring, resolveActiveCredentialKey, parseCommerceConnectionCommandHmacKey,
  type CredentialKeyring,
} from "@modainteract/moda-interact-shared/security/credentials/node";
import {
  assertReadable, BACKGROUND_READABLE_KEYS, decodeConfiguration, type BackgroundReadableKey,
  type ConfigurationSnapshot, type KeyValues,
} from "./contracts.js";
import type { ConfigurationRepository, ConfigurationRow } from "./repository.js";
import { PlatformConfigurationFailure } from "./errors.js";

const validEnvironments = new Set(["local", "test", "development", "staging", "production"]);
const keyIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const b64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const policies = new Set<string>(["woo.couponSync", "speech.transcription", "omini.moderation"]);

function strictB64(input: unknown, length?: number): Uint8Array {
  if (typeof input !== "string" || !input || !b64.test(input)) throw new Error("invalid");
  const decoded = Buffer.from(input, "base64");
  if (decoded.toString("base64") !== input || !decoded.length || decoded.length > 8192 ||
      (length !== undefined && decoded.length !== length)) throw new Error("invalid");
  return Uint8Array.from(decoded);
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function parseSealed(row: ConfigurationRow): { keyId: string; nonce: Uint8Array; ciphertext: Uint8Array; authTag: Uint8Array } {
  const value = row.value;
  if (!record(value) || Object.keys(value).sort().join("|") !==
      ["kind", "schemaVersion", "algorithm", "wrappingKeyId", "nonce", "ciphertext", "authTag"].sort().join("|") ||
      value.kind !== "sealed" || value.schemaVersion !== 1 || value.algorithm !== "AES-256-GCM" ||
      typeof value.wrappingKeyId !== "string" || !keyIdPattern.test(value.wrappingKeyId) ||
      ["__proto__", "prototype", "constructor"].includes(value.wrappingKeyId)) {
    throw new PlatformConfigurationFailure("INVALID", row.key);
  }
  try {
    return { keyId: value.wrappingKeyId, nonce: strictB64(value.nonce, 12),
      ciphertext: strictB64(value.ciphertext), authTag: strictB64(value.authTag, 16) };
  } catch { throw new PlatformConfigurationFailure("INVALID", row.key); }
}
function disabled(value: unknown): boolean {
  return record(value) && Object.keys(value).sort().join("|") === "kind|schemaVersion" &&
    value.kind === "disabled" && value.schemaVersion === 1;
}

export type UnsealKeyringProvider = () => CredentialKeyring;
export function createExternalUnsealKeyringProvider(environment: Readonly<NodeJS.ProcessEnv> = process.env): UnsealKeyringProvider {
  return () => {
    try {
      const ring = parseCredentialKeyring(environment.MODA_CONFIG_UNSEAL_KEY);
      // Verify the active key is valid even though reading old rows uses their persisted key ID.
      resolveActiveCredentialKey(ring, environment.MODA_CONFIG_UNSEAL_ACTIVE_KEY_ID);
      return ring;
    } catch { throw new PlatformConfigurationFailure("UNSEAL_FAILED", "configuration-root"); }
  };
}
export interface BackgroundPlatformConfigurationService {
  read<K extends BackgroundReadableKey>(key: K): Promise<ConfigurationSnapshot<K>>;
  readBundle<const K extends BackgroundReadableKey>(keys: readonly K[]): Promise<Readonly<{ [P in K]: ConfigurationSnapshot<P> }>>;
  /** One query for moderation policy and its shared OpenAI provider credential. */
  requireModerationOperation(): Promise<Readonly<{
    moderation: ConfigurationSnapshot<"omini.moderation">;
    providerVersion: number;
    openAiApiKey: string;
  }>>;
}
export function createBackgroundPlatformConfigurationService(input: {
  repository: ConfigurationRepository;
  /** Trusted deployment identity; NEVER derive it from a request/tenant/job. */
  environment: string;
  unsealKeyring: UnsealKeyringProvider;
  /** Injected shared logger; production composition must supply this. */
  logger?: Pick<StructuredLogger, "info" | "warn">;
}): BackgroundPlatformConfigurationService {
  if (!validEnvironments.has(input.environment)) throw new PlatformConfigurationFailure("INVALID", "environment");
  // Never include database/provider errors, row JSON, AAD, envelope or credentials in a log.
  // Even an injected failing sink must not affect application correctness.
  const log = (level: "info" | "warn", event: string, fields: {
    keys: readonly string[]; reasonCode?: string; revisions?: readonly number[];
  }): void => {
    try { input.logger?.[level](event, fields); } catch { /* logging is best effort */ }
  };
  const readableKeys = new Set<string>(BACKGROUND_READABLE_KEYS);
  const parseRow = <K extends BackgroundReadableKey>(key: K, row: ConfigurationRow): ConfigurationSnapshot<K> => {
    if (row.environment !== input.environment || row.key !== key || !Number.isSafeInteger(row.version) || row.version < 1) {
      throw new PlatformConfigurationFailure("INVALID", key);
    }
    if (disabled(row.value)) throw new PlatformConfigurationFailure("DISABLED", key);
    let plaintext: unknown;
    if (policies.has(key)) {
      if (record(row.value) && (row.value.kind === "sealed" || row.value.kind === "disabled")) {
        throw new PlatformConfigurationFailure("INVALID", key);
      }
      plaintext = row.value;
    } else {
      const envelope = parseSealed(row);
      try {
        const text = decryptCredential({ keyring: input.unsealKeyring(), envelope,
          aad: JSON.stringify(["moda-platform-config-v1", input.environment, key, row.version, 1]) });
        if (Buffer.byteLength(text, "utf8") > 8192) throw new Error("invalid");
        plaintext = JSON.parse(text) as unknown;
      } catch { throw new PlatformConfigurationFailure("UNSEAL_FAILED", key); }
    }
    const result = decodeConfiguration(key, plaintext);
    if (key === "commerce.connectionKeys") {
      try {
        const value = result as KeyValues["commerce.connectionKeys"];
        const ring = parseCredentialKeyring(value.connectionKeysJson);
        resolveActiveCredentialKey(ring, value.activeKeyId);
        if (value.commandHmacKey !== undefined) parseCommerceConnectionCommandHmacKey(value.commandHmacKey, ring);
      } catch { throw new PlatformConfigurationFailure("INVALID", key); }
    }
    return Object.freeze({ key, version: row.version, value: Object.freeze(result) });
  };
  const readBundle = async <const K extends BackgroundReadableKey>(keys: readonly K[]): Promise<Readonly<{ [P in K]: ConfigurationSnapshot<P> }>> => {
    // Untrusted runtime casts may contain arbitrary strings; never place them in logs.
    const safeKeys = keys.filter((key) => readableKeys.has(key));
    try {
    for (const key of keys) assertReadable(key); // runtime defence against casts/JS callers
    if (!keys.length || new Set(keys).size !== keys.length) throw new PlatformConfigurationFailure("INVALID", "bundle");
    let rows: readonly ConfigurationRow[];
    try { rows = await input.repository.readRows(input.environment, keys); }
    catch { throw new PlatformConfigurationFailure("DB_UNAVAILABLE", "bundle"); }
    const byKey = new Map<string, ConfigurationRow>();
    for (const row of rows) {
      if (!keys.includes(row.key as K) || byKey.has(row.key)) throw new PlatformConfigurationFailure("INVALID", "bundle");
      byKey.set(row.key, row);
    }
    const output: Record<string, ConfigurationSnapshot<BackgroundReadableKey>> = {};
    for (const key of keys) {
      const row = byKey.get(key);
      if (!row) throw new PlatformConfigurationFailure("MISSING", key);
      output[key] = parseRow(key, row);
    }
    const speech = output["speech.transcription"]?.value as KeyValues["speech.transcription"] | undefined;
    const speechKeys = output["ai.providers"]?.value as KeyValues["ai.providers"] | undefined;
    if (speech && speechKeys && !speechKeys[speech.provider === "groq" ? "groqApiKey" : "openAiApiKey"]) {
      throw new PlatformConfigurationFailure("INVALID", "ai.providers");
    }
    log("info", "background.platform_configuration.read_succeeded", {
      keys: safeKeys, revisions: keys.map((key) => output[key]!.version),
    });
    return Object.freeze(output) as { [P in K]: ConfigurationSnapshot<P> };
    } catch (error) {
      log("warn", "background.platform_configuration.read_failed", {
        keys: safeKeys,
        reasonCode: error instanceof PlatformConfigurationFailure ? error.code : "INVALID",
      });
      throw error;
    }
  };
  return {
    async read<K extends BackgroundReadableKey>(key: K): Promise<ConfigurationSnapshot<K>> {
      const snapshot = await readBundle([key]);
      return snapshot[key];
    },
    readBundle,
    async requireModerationOperation() {
      const values = await readBundle(["omini.moderation", "ai.providers"]);
      const openAiApiKey = values["ai.providers"].value.openAiApiKey;
      if (!openAiApiKey) throw new PlatformConfigurationFailure("INVALID", "ai.providers");
      return Object.freeze({
        moderation: values["omini.moderation"],
        providerVersion: values["ai.providers"].version,
        openAiApiKey,
      });
    },
  };
}
