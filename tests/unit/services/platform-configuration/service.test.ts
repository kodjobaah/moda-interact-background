import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
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
  it("recognises 19 exact registry identities, reads eleven purposes, and denies the other eight", async () => {
    expect(new Set(REGISTERED_KEYS).size).toBe(19);
    expect(new Set(BACKGROUND_READABLE_KEYS).size).toBe(11);
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
      "shopBrand.publicMedia": { publicOrigin: "https://shop-brands.modainteract.com", bucketName: "moda-interact-shop-brands" },
      "ai.providers": { openAiApiKey: "openai-generic-secret", groqApiKey: "groq-generic-secret" },
      "omini.moderation": moderation,
    };
    const rows = Object.entries(values).map(([key, value]) => row(key,
      ["woo.couponSync", "speech.transcription", "omini.moderation", "shopBrand.publicMedia"].includes(key) ? value : seal(key, 1, value)));
    const context = setup(rows);
    for (const key of BACKGROUND_READABLE_KEYS) {
      expect((await context.service.read(key)).value).toEqual(values[key]);
    }
    expect(context.readRows).toHaveBeenCalledTimes(11);
  });

  it("uses the approved public ShopBrand media defaults on read without creating a row", async () => {
    const context = setup([]);
    expect(await context.service.read("shopBrand.publicMedia")).toEqual({
      key: "shopBrand.publicMedia", version: 0, value: {
        publicOrigin: "https://shop-brands.modainteract.com", bucketName: "moda-interact-shop-brands",
      },
    });
    expect(context.readRows).toHaveBeenCalledExactlyOnceWith("test", ["shopBrand.publicMedia"]);
    context.update([row("shopBrand.publicMedia", {
      publicOrigin: "https://brand.example.shop", bucketName: "brand-images",
    }, 7)]);
    expect(await context.service.read("shopBrand.publicMedia")).toMatchObject({ version: 7,
      value: { publicOrigin: "https://brand.example.shop", bucketName: "brand-images" } });
    expect(context.readRows).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid stored ShopBrand public-media policies and does not borrow Merchant Knowledge credentials", async () => {
    const context = setup([]);
    const valid = { publicOrigin: "https://brand.example.shop", bucketName: "brand-images" };
    for (const value of [
      { ...valid, publicOrigin: "http://brand.example.shop" },
      { ...valid, publicOrigin: "https://127.0.0.1" },
      { ...valid, publicOrigin: "https://brand.example.shop/private" },
      { ...valid, publicOrigin: "https://brand.example.shop?token=secret" },
      { ...valid, publicOrigin: "https://example.com" },
      { ...valid, bucketName: "example-bucket" },
      { ...valid, unexpectedKey: "leak" },
      { kind: "sealed", schemaVersion: 1 },
    ]) {
      context.update([row("shopBrand.publicMedia", value)]);
      await expect(context.service.read("shopBrand.publicMedia")).rejects.toMatchObject({ code: "INVALID" });
    }
    context.update([row("shopBrand.publicMedia", { kind: "disabled", schemaVersion: 1 })]);
    await expect(context.service.read("shopBrand.publicMedia")).rejects.toMatchObject({ code: "DISABLED" });
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

  it("decrypts a fixed envelope generated by the Admin sealSecret writer and checks frozen AAD", async () => {
    // Immutable test-only artifact produced by Admin src/lib/admin/platform-configuration/seal.ts.
    // Deliberately DO NOT call encryptCredential to generate the value under test.
    const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/platform-configuration/admin-sealed-ai-providers.v1.json", import.meta.url), "utf8")) as ConfigurationRow;
    const service = createBackgroundPlatformConfigurationService({
      repository: { readRows: async () => [fixture] }, environment: "test", unsealKeyring: () => wrapping,
    });
    expect((await service.read("ai.providers")).value).toEqual({ openAiApiKey: "ADMIN-VECTOR-OPENAI-KEY-2026-10-18" });
    const alteredVersion = createBackgroundPlatformConfigurationService({
      repository: { readRows: async () => [{ ...fixture, version: fixture.version + 1 }] },
      environment: "test", unsealKeyring: () => wrapping,
    });
    await expect(alteredVersion.read("ai.providers")).rejects.toMatchObject({ code: "UNSEAL_FAILED" });
    const alteredPurpose = createBackgroundPlatformConfigurationService({
      repository: { readRows: async () => [{ ...fixture, key: "messaging.sender" }] },
      environment: "test", unsealKeyring: () => wrapping,
    });
    await expect(alteredPurpose.read("messaging.sender")).rejects.toMatchObject({ code: "UNSEAL_FAILED" });
  });

  it("logs bounded outcomes from injectable shared logger without leaking secrets, envelope or DB errors", async () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/platform-configuration/admin-sealed-ai-providers.v1.json", import.meta.url), "utf8")) as ConfigurationRow;
    const info = vi.fn();
    const warn = vi.fn();
    let returnedRows: ConfigurationRow[] = [fixture];
    const service = createBackgroundPlatformConfigurationService({
      repository: { readRows: async () => returnedRows }, environment: "test", unsealKeyring: () => wrapping,
      logger: { info, warn },
    });
    expect((await service.read("ai.providers")).value.openAiApiKey).toBe("ADMIN-VECTOR-OPENAI-KEY-2026-10-18");
    expect(info).toHaveBeenCalledWith("background.platform_configuration.read_succeeded", expect.objectContaining({
      keys: ["ai.providers"], revisions: [7], correlationId: expect.any(String),
    }));
    returnedRows = [{ ...fixture, value: { ...(fixture.value as Record<string, unknown>), authTag: Buffer.alloc(16, 0).toString("base64") } }];
    let failure: unknown;
    try { await service.read("ai.providers"); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "UNSEAL_FAILED" });
    expect(warn).toHaveBeenCalledWith("background.platform_configuration.read_failed", expect.objectContaining({
      keys: ["ai.providers"], correlationId: expect.any(String), rowRevisions: { "ai.providers": 7 },
      reasonCode: "UNSEAL_FAILED",
    }));
    // Both errors and logged output are checked as text, not merely by error code.
    const exposed = JSON.stringify({ message: String(failure), error: failure, info: info.mock.calls, warn: warn.mock.calls });
    const envelope = fixture.value as { nonce: string; ciphertext: string; authTag: string };
    for (const forbidden of ["ADMIN-VECTOR-OPENAI-KEY-2026-10-18", envelope.nonce, envelope.ciphertext, envelope.authTag]) {
      expect(exposed).not.toContain(forbidden);
    }
    await expect(service.read("auth.admin" as never)).rejects.toMatchObject({ code: "DENIED" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("auth.admin");
  });

  it("redacts database exception messages and isolates a throwing shared logging sink", async () => {
    const sensitive = "DATABASE_ERROR_WITH_SECRET_ABC123";
    const logger = { info: vi.fn(() => { throw new Error(sensitive); }),
      warn: vi.fn(() => { throw new Error(sensitive); }) };
    const success = createBackgroundPlatformConfigurationService({
      repository: { readRows: async () => [row("omini.moderation", moderation)] },
      environment, unsealKeyring: () => wrapping, logger,
    });
    expect((await success.read("omini.moderation")).value).toEqual(moderation);
    const failure = createBackgroundPlatformConfigurationService({
      repository: { readRows: async () => { throw new Error(sensitive); } },
      environment, unsealKeyring: () => wrapping, logger,
    });
    let caught: unknown;
    try { await failure.read("omini.moderation"); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: "DB_UNAVAILABLE" });
    expect(JSON.stringify(caught)).not.toContain(sensitive);
    expect(String(caught)).not.toContain(sensitive);
    expect(logger.warn).toHaveBeenCalledWith("background.platform_configuration.read_failed", expect.objectContaining({
      keys: ["omini.moderation"], correlationId: expect.any(String), reasonCode: "DB_UNAVAILABLE",
    }));
  });



  it("returns one coherent four-purpose sealed bundle with complete versioned values", async () => {
    const purposes = ["merchant.knowledge.r2", "commerce.connectionKeys", "shopify.partner", "messaging.sender"] as const;
    const expected = {
      "merchant.knowledge.r2": r2,
      "shopBrand.publicMedia": { publicOrigin: "https://shop-brands.modainteract.com", bucketName: "moda-interact-shop-brands" },
      "commerce.connectionKeys": {
        connectionKeysJson: JSON.stringify({ "previous": Buffer.alloc(32, 2).toString("base64"),
          "active": Buffer.alloc(32, 3).toString("base64") }),
        activeKeyId: "active",
      },
      "shopify.partner": { accessToken: "PRIVATE-PARTNER-TOKEN-235", organizationId: "org-45",
        appId: "app-52", apiVersion: "2026-10" },
      "messaging.sender": { accessToken: "PRIVATE-SENDER-TOKEN-563", phoneNumberId: "111222333",
        businessAccountId: "999888777" },
    };
    const versions = [2, 3, 4, 5];
    const context = setup(purposes.map((key, index) => row(key, seal(key, versions[index]!, expected[key]), versions[index]!)));
    const bundle = await context.service.readBundle(purposes);
    for (const [index, key] of purposes.entries()) {
      expect(bundle[key]).toEqual({ key, version: versions[index], value: expected[key] });
    }
    expect(context.readRows).toHaveBeenCalledTimes(1);
    expect(context.readRows).toHaveBeenCalledWith("test", purposes);
    expect(Object.keys(bundle)).toEqual([...purposes]);
  });

  it("redacts denied unknown keys, malformed/revoked rows and failed unseal/DB diagnostics in errors and logs", async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const SENTINELS = ["SUPPLIED-KEY-PRIVATE", "SUPPLIED-ROW-PRIVATE", "SUPPLIED-DB-PRIVATE",
      "SUPPLIED-ROOT-PRIVATE", "R2-SECRET-123"];
    let activeRows: ConfigurationRow[] = [];
    let databaseError: Error | null = null;
    let rootError: Error | null = null;
    const readRows = vi.fn(async (env: string, keys: readonly string[]) => {
      if (databaseError) throw databaseError;
      return activeRows.filter((r) => r.environment === env && keys.includes(r.key));
    });
    const service = createBackgroundPlatformConfigurationService({ environment,
      repository: { readRows }, unsealKeyring: () => {
        if (rootError) throw rootError;
        return wrapping;
      }, logger: { info, warn } });
    const failures: unknown[] = [];
    async function expectFailure(action: () => Promise<unknown>, code: string, key: string): Promise<void> {
      let caught: unknown;
      try { await action(); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code, key });
      failures.push(caught);
      const metadata = warn.mock.lastCall?.[1] as Record<string, unknown>;
      expect(metadata).toMatchObject({ reasonCode: code, correlationId: expect.any(String) });
      expect(metadata.correlationId).toMatch(/^[a-f0-9-]{36}$/);
    }
    await expectFailure(() => service.read("SUPPLIED-KEY-PRIVATE" as never), "DENIED", "unauthorised-key");
    expect(readRows).not.toHaveBeenCalled();
    activeRows = [row("merchant.knowledge.r2", { kind: "sealed", schemaVersion: 1,
      algorithm: "AES-256-GCM", wrappingKeyId: "SUPPLIED-ROW-PRIVATE" }, 8)];
    await expectFailure(() => service.read("merchant.knowledge.r2"), "INVALID", "merchant.knowledge.r2");
    expect(warn.mock.lastCall?.[1]).toMatchObject({ rowRevisions: { "merchant.knowledge.r2": 8 } });
    activeRows = [row("merchant.knowledge.r2", { kind: "disabled", schemaVersion: 1 }, 9)];
    await expectFailure(() => service.read("merchant.knowledge.r2"), "DISABLED", "merchant.knowledge.r2");
    expect(warn.mock.lastCall?.[1]).toMatchObject({ rowRevisions: { "merchant.knowledge.r2": 9 } });
    activeRows = [row("merchant.knowledge.r2", seal("merchant.knowledge.r2", 10, r2), 10)];
    rootError = new Error("SUPPLIED-ROOT-PRIVATE");
    await expectFailure(() => service.read("merchant.knowledge.r2"), "UNSEAL_FAILED", "merchant.knowledge.r2");
    expect(warn.mock.lastCall?.[1]).toMatchObject({ rowRevisions: { "merchant.knowledge.r2": 10 } });
    rootError = null;
    databaseError = new Error("SUPPLIED-DB-PRIVATE");
    await expectFailure(() => service.read("merchant.knowledge.r2"), "DB_UNAVAILABLE", "bundle");
    expect(warn.mock.lastCall?.[1]).not.toHaveProperty("rowRevisions");
    expect(warn.mock.calls).toHaveLength(5);
    const logged = JSON.stringify({ failures: failures.map((error) => ({ error, text: String(error) })),
      info: info.mock.calls, warn: warn.mock.calls });
    for (const privateValue of SENTINELS) expect(logged).not.toContain(privateValue);
    const correlations = warn.mock.calls.map((call) => (call[1] as { correlationId: string }).correlationId);
    expect(new Set(correlations).size).toBe(correlations.length);
  });

});
