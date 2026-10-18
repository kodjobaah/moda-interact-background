import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { encryptCredential, parseCredentialKeyring } from "@modainteract/moda-interact-shared/security/credentials/node";
import { BACKGROUND_READABLE_KEYS, REGISTERED_KEYS } from "../../../../src/services/platform-configuration/contracts.js";
import { createBackgroundPlatformConfigurationService } from "../../../../src/services/platform-configuration/service.js";
import type { ConfigurationRow } from "../../../../src/services/platform-configuration/repository.js";

const environment = "test";
const wrapping = parseCredentialKeyring(JSON.stringify({ "root-v1": Buffer.alloc(32, 7).toString("base64") }));
const seal = (key: string, version: number, payload: unknown) => {
  const encrypted = encryptCredential({ keyring: wrapping, activeKeyId: "root-v1",
    plaintext: JSON.stringify(payload), aad: JSON.stringify(["moda-platform-config-v1", environment, key, version, 1]) });
  return { kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM", wrappingKeyId: encrypted.keyId,
    nonce: Buffer.from(encrypted.nonce).toString("base64"),
    ciphertext: Buffer.from(encrypted.ciphertext).toString("base64"),
    authTag: Buffer.from(encrypted.authTag).toString("base64") };
};
const row = (key: string, value: unknown, version = 1): ConfigurationRow => ({ key, environment, version, value });
const moderation = { baseUrl: "https://api.openai.com/v1/moderations", modelId: "omni-moderation-latest" };
const speech = { provider: "openai", groqModelId: "whisper-large-v3-turbo", openaiModelId: "gpt-4o-mini-transcribe" };
const r2 = { endpoint: "https://account.r2.cloudflarestorage.com", bucket: "merchants-data", accessKeyId: "R2-ACCESS-123",
  secretAccessKey: "R2-SECRET-123", maxUploadBytes: 26214400, maxXlsxUncompressedBytes: 2147483647 };

function setup(initial: ConfigurationRow[]) {
  let rows = initial;
  const readRows = vi.fn(async (requestedEnvironment: string, keys: readonly string[]) =>
    rows.filter((item) => item.environment === requestedEnvironment && keys.includes(item.key)));
  const service = createBackgroundPlatformConfigurationService({ repository: { readRows },
    environment, unsealKeyring: () => wrapping });
  return { service, readRows, update: (next: ConfigurationRow[]) => { rows = next; } };
}


describe("ARCH-043 Background typed configuration read boundary", () => {
  it("recognises 18 exact registry identities, reads ten purposes, and denies the other eight", async () => {
    expect(new Set(REGISTERED_KEYS).size).toBe(18);
    expect(new Set(BACKGROUND_READABLE_KEYS).size).toBe(10);
    const { service, readRows } = setup([]);
    for (const key of REGISTERED_KEYS.filter((key) => !BACKGROUND_READABLE_KEYS.includes(key as never))) {
      await expect(service.read(key as never)).rejects.toMatchObject({ code: "DENIED" });
    }
    expect(readRows).not.toHaveBeenCalled();
  });

  it("exposes omini.moderation as a typed policy with exact Admin defaults and fresh revision", async () => {
    const context = setup([row("omini.moderation", moderation)]);
    expect(await context.service.read("omini.moderation")).toEqual({ key: "omini.moderation", version: 1, value: moderation });
    context.update([row("omini.moderation", { ...moderation, modelId: "omni-moderation-v2" }, 2)]);
    expect((await context.service.read("omini.moderation")).value.modelId).toBe("omni-moderation-v2");
    expect(context.readRows).toHaveBeenCalledTimes(2);
    expect(context.readRows).toHaveBeenLastCalledWith("test", ["omini.moderation"]);
  });

  it("rejects missing, disabled, malformed and unsafe moderation configuration", async () => {
    const context = setup([]);
    await expect(context.service.read("omini.moderation")).rejects.toMatchObject({ code: "MISSING" });
    for (const value of [
      { kind: "disabled", schemaVersion: 1 },
      { ...moderation, modelId: "bad model" },
      { ...moderation, baseUrl: "http://api.openai.com/v1/moderations" },
      { ...moderation, baseUrl: "https://user:pass@api.openai.com/v1/moderations" },
      { ...moderation, secret: "do-not-expose" },
    ]) {
      context.update([row("omini.moderation", value)]);
      await expect(context.service.read("omini.moderation")).rejects.toMatchObject({ code: "kind" in value ? "DISABLED" : "INVALID" });
    }
  });

  it("reads encrypted purposes without exposing a generic arbitrary-key reader", async () => {
    const context = setup([
      row("merchant.knowledge.r2", seal("merchant.knowledge.r2", 1, r2)),
      row("ai.providers", seal("ai.providers", 1, { openAiApiKey: "openai-shared-secret" })),
      row("speech.transcription", speech),
    ]);
    expect((await context.service.read("merchant.knowledge.r2")).value).toEqual(r2);
    expect((await context.service.read("ai.providers")).value).toEqual({ openAiApiKey: "openai-shared-secret" });
    expect(await context.service.readBundle(["speech.transcription", "ai.providers"]))
      .toMatchObject({ "speech.transcription": { value: speech }, "ai.providers": { value: { openAiApiKey: "openai-shared-secret" } } });
    expect(context.readRows).toHaveBeenCalledTimes(3);
    expect(context.readRows).toHaveBeenLastCalledWith("test", ["speech.transcription", "ai.providers"]);
  });

  it("strictly decodes all approved policy and sealed credential purposes", async () => {
    const woo = { dispatchBatchSize: 500, refreshIntervalMinutes: 30, dispatchCooldownMinutes: 5,
      unavailableRecheckMinutes: 30, staleScanMinutes: 15, maxPages: 50, requestTimeoutMs: 8000,
      maxResponseBytes: 1048576, maxScanDurationMs: 120000, workerConcurrency: 4 };
    const values = {
      "woo.couponSync": woo,
      "speech.transcription": speech,
      "commerce.connectionKeys": { connectionKeysJson: JSON.stringify({ "v1": Buffer.alloc(32, 2).toString("base64") }), activeKeyId: "v1" },
      "shopify.oauth": { apiKey: "shopify-public", apiSecret: "shopify-private" },
      "shopify.partner": { accessToken: "partner-private", organizationId: "business-123", appId: "app-12", apiVersion: "2026-10" },
      "shopify.appEvents": { clientId: "client-12", clientSecret: "app-private" },
      "messaging.sender": { accessToken: "meta-private", phoneNumberId: "12345", businessAccountId: "98765" },
      "merchant.knowledge.r2": r2,
      "ai.providers": { openAiApiKey: "openai-generic-secret", groqApiKey: "groq-generic-secret" },
      "omini.moderation": moderation,
    };
    const rows = Object.entries(values).map(([key, value]) => row(key,
      ["woo.couponSync", "speech.transcription", "omini.moderation"].includes(key) ? value : seal(key, 1, value)));
    const context = setup(rows);
    for (const key of BACKGROUND_READABLE_KEYS) {
      expect((await context.service.read(key)).value).toEqual(values[key]);
    }
    expect(context.readRows).toHaveBeenCalledTimes(10);
  });

  it("denies wrong environment, legacy names, tampering and incorrect root key without leaking secrets", async () => {
    const context = setup([row("merchant.knowledge.r2", seal("merchant.knowledge.r2", 1, r2))]);
    const valid = seal("merchant.knowledge.r2", 1, r2);
    context.update([row("merchant.knowledge.r2", { ...valid, authTag: Buffer.alloc(16, 4).toString("base64") })]);
    await expect(context.service.read("merchant.knowledge.r2")).rejects.toMatchObject({ code: "UNSEAL_FAILED" });
    context.update([{ ...row("merchant.knowledge.r2", valid), environment: "production" }]);
    await expect(context.service.read("merchant.knowledge.r2")).rejects.toMatchObject({ code: "MISSING" });
    context.update([row("merchantKnowledge.upload", r2)]);
    await expect(context.service.read("merchant.knowledge.r2")).rejects.toMatchObject({ code: "MISSING" });
    const wrong = createBackgroundPlatformConfigurationService({ repository: { readRows: async () => [row("merchant.knowledge.r2", valid)] },
      environment, unsealKeyring: () => parseCredentialKeyring(JSON.stringify({ "other-root": Buffer.alloc(32, 5).toString("base64") })) });
    await expect(wrong.read("merchant.knowledge.r2")).rejects.toMatchObject({ code: "UNSEAL_FAILED" });
  });

  it("fails closed for unavailable database and mismatched selected speech provider credential", async () => {
    const unavailable = createBackgroundPlatformConfigurationService({ repository: { readRows: async () => { throw new Error("secret leak 123"); } },
      environment, unsealKeyring: () => wrapping });
    await expect(unavailable.read("omini.moderation")).rejects.toMatchObject({ code: "DB_UNAVAILABLE" });
    const context = setup([row("ai.providers", seal("ai.providers", 1, { groqApiKey: "groq-secret" })), row("speech.transcription", speech)]);
    await expect(context.service.readBundle(["speech.transcription", "ai.providers"]))
      .rejects.toMatchObject({ code: "INVALID" });
  });
  it("reuses one generic OpenAI credential for speech and future moderation without provider calls", async () => {
    const context = setup([
      row("omini.moderation", moderation),
      row("speech.transcription", speech),
      row("ai.providers", seal("ai.providers", 1, { openAiApiKey: "provider-secret-for-both" })),
    ]);
    expect((await context.service.readBundle(["speech.transcription", "ai.providers"]))["ai.providers"].value.openAiApiKey)
      .toBe("provider-secret-for-both");
    expect(await context.service.requireModerationOperation()).toMatchObject({
      moderation: { key: "omini.moderation", value: moderation },
      providerVersion: 1,
      openAiApiKey: "provider-secret-for-both",
    });
    expect(context.readRows).toHaveBeenLastCalledWith("test", ["omini.moderation", "ai.providers"]);
    expect(context.readRows).toHaveBeenCalledTimes(2);
  });

  it("rejects old feature-named provider fields and moderation without an OpenAI key", async () => {
    const context = setup([
      row("omini.moderation", moderation),
      row("ai.providers", seal("ai.providers", 1, { openAiSpeechApiKey: "obsolete-secret" })),
    ]);
    await expect(context.service.requireModerationOperation()).rejects.toMatchObject({ code: "INVALID" });
    context.update([
      row("omini.moderation", moderation),
      row("ai.providers", seal("ai.providers", 2, { groqApiKey: "groq-only" }), 2),
    ]);
    await expect(context.service.requireModerationOperation()).rejects.toMatchObject({ code: "INVALID", key: "ai.providers" });
    context.update([row("omini.moderation", moderation)]);
    await expect(context.service.requireModerationOperation()).rejects.toMatchObject({ code: "MISSING", key: "ai.providers" });
  });

});
