import { PlatformConfigurationFailure } from "./errors.js";

/** ARCH-043 Admin registry, including the 18 October moderation policy addition.
 * Keep this exact identity list in sync with the architect-approved Admin contract.
 * Background is not permitted to read all registered purposes. */
export const REGISTERED_KEYS = [
  "auth.admin", "auth.commerce", "commerce.bootstrap", "commerce.connectionKeys",
  "shopify.oauth", "shopify.partner", "shopify.appEvents", "merchant.knowledge.r2",
  "woocommerce.auth", "woocommerce.billing", "messaging.meta", "messaging.sender",
  "ai.providers", "speech.transcription", "woo.couponSync", "admin.grafana",
  "commerce.preview", "omini.moderation", "shopBrand.publicMedia",
] as const;
export type RegisteredKey = typeof REGISTERED_KEYS[number];

export const BACKGROUND_READABLE_KEYS = [
  "commerce.connectionKeys", "shopify.oauth", "shopify.partner", "shopify.appEvents",
  "merchant.knowledge.r2", "messaging.sender", "ai.providers", "speech.transcription",
  "woo.couponSync", "omini.moderation", "shopBrand.publicMedia",
] as const;
export type BackgroundReadableKey = typeof BACKGROUND_READABLE_KEYS[number];
const allowed = new Set<string>(BACKGROUND_READABLE_KEYS);
export function assertReadable(key: string): asserts key is BackgroundReadableKey {
  if (!allowed.has(key)) throw new PlatformConfigurationFailure("DENIED", "unauthorised-key");
}

export type ShopBrandPublicMediaSettings = Readonly<{ publicOrigin: string; bucketName: string }>;
export const SHOP_BRAND_PUBLIC_MEDIA_DEFAULTS: ShopBrandPublicMediaSettings = Object.freeze({
  publicOrigin: "https://shop-brands.modainteract.com", bucketName: "moda-interact-shop-brands",
});
export type ModerationPolicy = Readonly<{ baseUrl: string | null; modelId: string }>;
export type WooCouponSyncPolicy = Readonly<{
  dispatchBatchSize: number; refreshIntervalMinutes: number; dispatchCooldownMinutes: number;
  unavailableRecheckMinutes: number; staleScanMinutes: number; maxPages: number;
  requestTimeoutMs: number; maxResponseBytes: number; maxScanDurationMs: number;
  workerConcurrency: number;
}>;
export type SpeechPolicy = Readonly<{ provider: "groq" | "openai"; groqModelId: string; openaiModelId: string }>;
export type MerchantKnowledgeR2Settings = Readonly<{
  endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string;
  maxUploadBytes: number; maxXlsxUncompressedBytes: number;
}>;
export type CommerceConnectionSecurity = Readonly<{
  connectionKeysJson: string; activeKeyId: string; commandHmacKey?: string;
}>;
export type ShopifyOAuthCredentials = Readonly<{ apiKey: string; apiSecret: string }>;
export type ShopifyPartnerCredentials = Readonly<{ accessToken: string; organizationId: string; appId: string; apiVersion?: string }>;
export type ShopifyAppEventsCredentials = Readonly<{ clientId: string; clientSecret: string }>;
export type WhatsAppSenderCredentials = Readonly<{ accessToken: string; phoneNumberId: string; businessAccountId: string }>;
/** Provider-scoped server credentials shared across authorised operations. */
export type ProviderApiKeys = Readonly<{ groqApiKey?: string; openAiApiKey?: string }>;

export type KeyValues = {
  "commerce.connectionKeys": CommerceConnectionSecurity;
  "shopify.oauth": ShopifyOAuthCredentials;
  "shopify.partner": ShopifyPartnerCredentials;
  "shopify.appEvents": ShopifyAppEventsCredentials;
  "merchant.knowledge.r2": MerchantKnowledgeR2Settings;
  "shopBrand.publicMedia": ShopBrandPublicMediaSettings;
  "messaging.sender": WhatsAppSenderCredentials;
  "ai.providers": ProviderApiKeys;
  "speech.transcription": SpeechPolicy;
  "woo.couponSync": WooCouponSyncPolicy;
  "omini.moderation": ModerationPolicy;
};
export type ConfigurationSnapshot<K extends BackgroundReadableKey> = Readonly<{
  key: K; version: number; value: Readonly<KeyValues[K]>;
}>;

const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function objectFor(key: string, value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!plain(value) || required.some((name) => !Object.hasOwn(value, name)) ||
    Object.keys(value).some((name) => !required.includes(name) && !optional.includes(name))) {
    throw new PlatformConfigurationFailure("INVALID", key);
  }
  return value;
}
function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 0x20) return true;
  }
  return false;
}
function str(key: string, value: unknown, max = 2048): string {
  if (typeof value !== "string" || !value.length || value.length > max || value.trim() !== value || containsAsciiControlCharacter(value)) {
    throw new PlatformConfigurationFailure("INVALID", key);
  }
  return value;
}
function secret(key: string, value: unknown): string { return str(key, value, 8192); }
function model(key: string, value: unknown): string {
  const text = str(key, value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) throw new PlatformConfigurationFailure("INVALID", key);
  return text;
}
function integer(key: string, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new PlatformConfigurationFailure("INVALID", key);
  }
  return value;
}
function safeHttps(key: string, value: unknown, r2 = false): string {
  const text = str(key, value, 2048);
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || (url.port && url.port !== "443")) throw new Error();
    const host = url.hostname.toLowerCase();
    if (!host.includes(".") || host === "localhost" || /\.(?:local|localhost|test|invalid|example|internal)$/.test(host) ||
        /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host) ||
        host.startsWith("[") || /^\d+(?:\.\d+){3}$/.test(host) ||
        (r2 && url.pathname !== "/")) throw new Error();
    return text;
  } catch { throw new PlatformConfigurationFailure("INVALID", key); }
}
function requiredText(value: Record<string, unknown>, key: string, names: readonly string[], max = 2048): Record<string, string> {
  return Object.fromEntries(names.map((field) => [field, str(key, value[field], max)]));
}
function optionalSecret(key: string, value: Record<string, unknown>, field: string): string | undefined {
  return value[field] === undefined ? undefined : secret(key, value[field]);
}
function bucketName(key: string, value: unknown): string {
  const bucket = str(key, value, 63);
  if (!/^(?!.*\.\.)(?!.*\.-|.*-\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
      /^\d+\.\d+\.\d+\.\d+$/.test(bucket) ||
      ["configured-bucket", "example-bucket", "your-bucket", "bucket-name"].includes(bucket)) {
    throw new PlatformConfigurationFailure("INVALID", key);
  }
  return bucket;
}

const wooFields = {
  dispatchBatchSize: [1, 500], refreshIntervalMinutes: [1, 1440],
  dispatchCooldownMinutes: [1, 120], unavailableRecheckMinutes: [1, 1440],
  staleScanMinutes: [1, 120], maxPages: [1, 200], requestTimeoutMs: [1000, 30000],
  maxResponseBytes: [16384, 4194304], maxScanDurationMs: [30000, 600000], workerConcurrency: [1, 32],
} as const;

export function decodeConfiguration<K extends BackgroundReadableKey>(key: K, raw: unknown): KeyValues[K] {
  switch (key) {
    case "shopBrand.publicMedia": {
      const row = objectFor(key, raw, ["publicOrigin", "bucketName"]);
      const origin = safeHttps(key, row.publicOrigin, true);
      if (/(?:^|\.)example\.(?:com|net|org)$/.test(new URL(origin).hostname)) {
        throw new PlatformConfigurationFailure("INVALID", key);
      }
      return { publicOrigin: origin, bucketName: bucketName(key, row.bucketName) } as KeyValues[K];
    }
    case "omini.moderation": {
      const row = objectFor(key, raw, ["baseUrl", "modelId"]);
      return { baseUrl: row.baseUrl === null ? null : safeHttps(key, row.baseUrl), modelId: model(key, row.modelId) } as KeyValues[K];
    }
    case "woo.couponSync": {
      const row = objectFor(key, raw, Object.keys(wooFields));
      const values: Record<string, number> = {};
      for (const [field, [min, max]] of Object.entries(wooFields)) values[field] = integer(key, row[field], min, max);
      return values as KeyValues[K];
    }
    case "speech.transcription": {
      const row = objectFor(key, raw, ["provider", "groqModelId", "openaiModelId"]);
      if (row.provider !== "groq" && row.provider !== "openai") throw new PlatformConfigurationFailure("INVALID", key);
      return { provider: row.provider, groqModelId: model(key, row.groqModelId), openaiModelId: model(key, row.openaiModelId) } as KeyValues[K];
    }
    case "merchant.knowledge.r2": {
      const row = objectFor(key, raw, ["endpoint", "bucket", "accessKeyId", "secretAccessKey", "maxUploadBytes", "maxXlsxUncompressedBytes"]);
      return {
        endpoint: safeHttps(key, row.endpoint, true), bucket: bucketName(key, row.bucket),
        accessKeyId: secret(key, row.accessKeyId), secretAccessKey: secret(key, row.secretAccessKey),
        maxUploadBytes: integer(key, row.maxUploadBytes, 1, 26214400),
        maxXlsxUncompressedBytes: integer(key, row.maxXlsxUncompressedBytes, 1, 2147483647),
      } as KeyValues[K];
    }
    case "commerce.connectionKeys": {
      const row = objectFor(key, raw, ["connectionKeysJson", "activeKeyId"], ["commandHmacKey"]);
      return { connectionKeysJson: secret(key, row.connectionKeysJson), activeKeyId: str(key, row.activeKeyId, 64),
        ...(row.commandHmacKey === undefined ? {} : { commandHmacKey: secret(key, row.commandHmacKey) }) } as KeyValues[K];
    }
    case "shopify.oauth": {
      const row = objectFor(key, raw, ["apiKey", "apiSecret"]);
      return requiredText(row, key, ["apiKey", "apiSecret"]) as KeyValues[K];
    }
    case "shopify.partner": {
      const row = objectFor(key, raw, ["accessToken", "organizationId", "appId"], ["apiVersion"]);
      const accessToken = secret(key, row.accessToken);
      const organizationId = str(key, row.organizationId, 128);
      const appId = str(key, row.appId, 128);
      if (row.apiVersion !== undefined && !/^\d{4}-(?:01|04|07|10)$/.test(str(key, row.apiVersion, 7))) {
        throw new PlatformConfigurationFailure("INVALID", key);
      }
      return { accessToken, organizationId, appId,
        ...(row.apiVersion === undefined ? {} : { apiVersion: row.apiVersion as string }) } as KeyValues[K];
    }
    case "shopify.appEvents": {
      const row = objectFor(key, raw, ["clientId", "clientSecret"]);
      return requiredText(row, key, ["clientId", "clientSecret"]) as KeyValues[K];
    }
    case "messaging.sender": {
      const row = objectFor(key, raw, ["accessToken", "phoneNumberId", "businessAccountId"]);
      return { accessToken: secret(key, row.accessToken), phoneNumberId: str(key, row.phoneNumberId, 32),
        businessAccountId: str(key, row.businessAccountId, 32) } as KeyValues[K];
    }
    case "ai.providers": {
      const row = objectFor(key, raw, [], ["groqApiKey", "openAiApiKey"]);
      const groqApiKey = optionalSecret(key, row, "groqApiKey");
      const openAiApiKey = optionalSecret(key, row, "openAiApiKey");
      if (!groqApiKey && !openAiApiKey) throw new PlatformConfigurationFailure("INVALID", key);
      return { ...(groqApiKey === undefined ? {} : { groqApiKey }),
        ...(openAiApiKey === undefined ? {} : { openAiApiKey }) } as KeyValues[K];
    }
    default: throw new PlatformConfigurationFailure("DENIED", key);
  }
}
