import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { encryptCredential, parseCredentialKeyring } from "@modainteract/moda-interact-shared/security/credentials/node";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createPrismaConfigurationRepository } from "../../src/services/platform-configuration/repository.js";
import { createBackgroundPlatformConfigurationService } from "../../src/services/platform-configuration/service.js";

const url = process.env.TEST_DATABASE_URL;
const describeWithDatabase = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

describeWithDatabase("ARCH-043 PostgreSQL Background moderation configuration", () => {
  it("reads one sealed generic OpenAI key with moderation policy and observes rotation", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const environment = "test";
    const keys = ["omini.moderation", "ai.providers"];
    const root = parseCredentialKeyring(JSON.stringify({ root: Buffer.alloc(32, 7).toString("base64") }));
    const seal = (version: number, secret: string) => {
      const encrypted = encryptCredential({
        keyring: root, activeKeyId: "root", plaintext: JSON.stringify({ openAiApiKey: secret }),
        aad: JSON.stringify(["moda-platform-config-v1", environment, "ai.providers", version, 1]),
      });
      return { kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM", wrappingKeyId: encrypted.keyId,
        nonce: Buffer.from(encrypted.nonce).toString("base64"),
        ciphertext: Buffer.from(encrypted.ciphertext).toString("base64"),
        authTag: Buffer.from(encrypted.authTag).toString("base64") };
    };
    try {
      for (const key of keys) {
        if (await db.platformConfiguration.findUnique({ where: { environment_key: { environment, key } } })) {
          throw new Error("Disposable integration test requires an empty configuration fixture namespace");
        }
      }
      await db.platformConfiguration.create({ data: { environment, key: "omini.moderation",
        value: { baseUrl: "https://api.openai.com/v1/moderations", modelId: "omni-moderation-latest" }, version: 1 } });
      await db.platformConfiguration.create({ data: { environment, key: "ai.providers", value: seal(1, "shared-openai-key-v1"), version: 1 } });
      const service = createBackgroundPlatformConfigurationService({ environment,
        repository: createPrismaConfigurationRepository(db), unsealKeyring: () => root });
      expect((await service.requireModerationOperation()).openAiApiKey).toBe("shared-openai-key-v1");
      await db.platformConfiguration.update({ where: { environment_key: { environment, key: "ai.providers" } },
        data: { value: seal(2, "shared-openai-key-v2"), version: 2 } });
      expect(await service.requireModerationOperation()).toMatchObject({ providerVersion: 2, openAiApiKey: "shared-openai-key-v2" });
      await db.platformConfiguration.update({ where: { environment_key: { environment, key: "ai.providers" } },
        data: { value: { kind: "disabled", schemaVersion: 1 }, version: 3 } });
      await expect(service.requireModerationOperation()).rejects.toMatchObject({ code: "DISABLED", key: "ai.providers" });
    } finally {
      await db.platformConfiguration.deleteMany({ where: { environment, key: { in: keys } } });
      await db.$disconnect();
    }
  });

  it("reads committed changes, refuses missing environments, and never leaks other purposes", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const env = "test";
    const key = "omini.moderation";
    const existing = await db.platformConfiguration.findUnique({ where: { environment_key: { environment: env, key } } });
    if (existing) throw new Error("Disposable integration test requires a fresh moderation fixture namespace");
    const id = randomUUID();
    // One transaction creates and updates the same indexed configuration row.
    try {
      await db.platformConfiguration.create({ data: { environment: env, key, value: {
        baseUrl: "https://api.openai.com/v1/moderations", modelId: `omni-moderation-${id}` }, version: 1 } });
      const reader = createBackgroundPlatformConfigurationService({
        environment: env, repository: createPrismaConfigurationRepository(db),
        unsealKeyring: () => { throw new Error("Policy read must never fetch a wrapping key"); },
      });
      expect((await reader.read("omini.moderation")).version).toBe(1);
      await db.platformConfiguration.update({ where: { environment_key: { environment: env, key } },
        data: { value: { baseUrl: null, modelId: "omni-moderation-latest" }, version: 2 } });
      expect((await reader.read("omini.moderation")).value).toEqual({ baseUrl: null, modelId: "omni-moderation-latest" });
      const production = createBackgroundPlatformConfigurationService({
        environment: "production", repository: createPrismaConfigurationRepository(db),
        unsealKeyring: () => { throw new Error("unused"); },
      });
      await expect(production.read("omini.moderation")).rejects.toMatchObject({ code: "MISSING" });
      await expect(reader.read("auth.admin" as never)).rejects.toMatchObject({ code: "DENIED" });
    } finally {
      await db.platformConfiguration.deleteMany({ where: { environment: env, key } });
      await db.$disconnect();
    }
  });


  it("reads a coherent R2/Commerce/Partner/Sender bundle and redacts revoked/malformed rows", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const env = "test";
    const keys = ["merchant.knowledge.r2", "commerce.connectionKeys", "shopify.partner", "messaging.sender"] as const;
    const root = parseCredentialKeyring(JSON.stringify({ root: Buffer.alloc(32, 7).toString("base64") }));
    const seal = (key: string, version: number, value: unknown) => {
      const encrypted = encryptCredential({ keyring: root, activeKeyId: "root", plaintext: JSON.stringify(value),
        aad: JSON.stringify(["moda-platform-config-v1", env, key, version, 1]) });
      return { kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM", wrappingKeyId: encrypted.keyId,
        nonce: Buffer.from(encrypted.nonce).toString("base64"),
        ciphertext: Buffer.from(encrypted.ciphertext).toString("base64"),
        authTag: Buffer.from(encrypted.authTag).toString("base64") };
    };
    const values = {
      "merchant.knowledge.r2": { endpoint: "https://account.r2.cloudflarestorage.com", bucket: "merchant-data",
        accessKeyId: "INTEGRATION-PRIVATE-R2-KEY", secretAccessKey: "INTEGRATION-PRIVATE-R2-SECRET",
        maxUploadBytes: 20000000, maxXlsxUncompressedBytes: 100000000 },
      "commerce.connectionKeys": { connectionKeysJson: JSON.stringify({ previous: Buffer.alloc(32, 2).toString("base64"),
        active: Buffer.alloc(32, 3).toString("base64") }), activeKeyId: "active" },
      "shopify.partner": { accessToken: "INTEGRATION-PRIVATE-SHOPIFY-TOKEN", organizationId: "org-42",
        appId: "app-42", apiVersion: "2026-10" },
      "messaging.sender": { accessToken: "INTEGRATION-PRIVATE-META-TOKEN", phoneNumberId: "123456789",
        businessAccountId: "987654321" },
    };
    const versions = [3, 4, 5, 6];
    const warn = vi.fn();
    try {
      for (const key of keys) {
        if (await db.platformConfiguration.findUnique({ where: { environment_key: { environment: env, key } } })) {
          throw new Error("Disposable test requires an empty environment/key namespace");
        }
      }
      for (const [index, key] of keys.entries()) {
        await db.platformConfiguration.create({ data: { environment: env, key, version: versions[index]!,
          value: seal(key, versions[index]!, values[key]) } });
      }
      const service = createBackgroundPlatformConfigurationService({ environment: env,
        repository: createPrismaConfigurationRepository(db), unsealKeyring: () => root,
        logger: { info: vi.fn(), warn } });
      const bundle = await service.readBundle(keys);
      for (const [index, key] of keys.entries()) {
        expect(bundle[key]).toEqual({ key, version: versions[index], value: values[key] });
      }
      await db.platformConfiguration.update({ where: { environment_key: { environment: env, key: keys[0] } },
        data: { version: 7, value: { kind: "disabled", schemaVersion: 1 } } });
      await expect(service.readBundle(keys)).rejects.toMatchObject({ code: "DISABLED", key: keys[0] });
      expect(warn.mock.lastCall?.[1]).toMatchObject({ reasonCode: "DISABLED", correlationId: expect.any(String),
        rowRevisions: { "merchant.knowledge.r2": 7 } });
      await db.platformConfiguration.update({ where: { environment_key: { environment: env, key: keys[0] } },
        data: { version: 8, value: { kind: "sealed", schemaVersion: 1, algorithm: "AES-256-GCM",
          wrappingKeyId: "INTEGRATION-PRIVATE-R2-KEY" } } });
      await expect(service.readBundle(keys)).rejects.toMatchObject({ code: "INVALID", key: keys[0] });
      expect(warn.mock.lastCall?.[1]).toMatchObject({ reasonCode: "INVALID", rowRevisions: { "merchant.knowledge.r2": 8 } });
      const exposed = JSON.stringify(warn.mock.calls);
      for (const secret of [values["merchant.knowledge.r2"].accessKeyId,
        values["merchant.knowledge.r2"].secretAccessKey, values["shopify.partner"].accessToken,
        values["messaging.sender"].accessToken]) expect(exposed).not.toContain(secret);
    } finally {
      await db.platformConfiguration.deleteMany({ where: { environment: env, key: { in: [...keys] } } });
      await db.$disconnect();
    }
  });

});
