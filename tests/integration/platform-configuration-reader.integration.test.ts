import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { encryptCredential, parseCredentialKeyring } from "@modainteract/moda-interact-shared/security/credentials/node";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
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
});
