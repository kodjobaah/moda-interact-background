import "dotenv/config";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createCommerceTranslationProviderCredentialAad } from "@modainteract/moda-interact-shared/commerce/model";
import { parseCredentialKeyring } from "@modainteract/moda-interact-shared/security/credentials/node";
import { describe, expect, it, vi } from "vitest";
import { createTranslationProviderCredentialResolver } from "../../src/commerce/translation-provider-credential.js";
import { TranslationReconciliationService } from "../../src/services/translation-reconciliation.service.js";
import { backgroundRuntimeConfig } from "../helpers/background-runtime-config.js";

const url = process.env.TEST_DATABASE_URL;
const pg = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

pg("ARCH-043 support translation credential revocation in PostgreSQL", () => {
  it("never uses a valid legacy OPENAI_API_KEY after the Commerce credential row is revoked", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const environment = "TEST" as const;
    const provider = "openai";
    const existing = await db.commerceTranslationProviderCredential.findUnique({
      where: { environment_provider: { environment, provider } },
    });
    if (existing) throw new Error("Expected a disposable, unoccupied Commerce credential namespace");
    const admin = await db.platformAdmin.create({ data: { email: `arch043-${randomUUID()}@test.invalid` } });
    const key = randomBytes(32);
    const keyring = parseCredentialKeyring(JSON.stringify({ active: key.toString("base64") }));
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(createCommerceTranslationProviderCredentialAad({ environment, provider, keyId: "active" }), "utf8"));
    const secret = "sk-SYNTHETIC-DATABASE-KEY-DO-NOT-LOG";
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-SYNTHETIC-LEGACY-KEY-DO-NOT-USE";
    try {
      await db.commerceTranslationProviderCredential.create({ data: {
        environment, provider, keyId: "active", editVersion: 1, nonce,
        ciphertext, authTag: cipher.getAuthTag(), updatedByAdminId: admin.id,
      } });
      const resolver = createTranslationProviderCredentialResolver({ db, keyring });
      await expect(resolver.resolve({ environment, provider })).resolves.toBe(secret);
      // Actual PostgreSQL revoke, not a mocked findUnique failure.
      await db.commerceTranslationProviderCredential.delete({ where: {
        environment_provider: { environment, provider },
      } });
      const batch = { id: `revoked-${randomUUID()}`, provider, model: "persisted-model",
        status: "SUBMISSION_UNKNOWN", pollSequence: 1, inputFileId: "input",
        providerBatchId: null, submissionStartedAt: null, outputFileId: null, errorFileId: null };
      const rows = [[], [], [], [], [batch]];
      const database = { $queryRaw: vi.fn(async () => rows.shift() ?? []),
        $executeRaw: vi.fn(), $transaction: vi.fn() };
      const queue = { add: vi.fn(), getJob: vi.fn(), close: vi.fn() };
      const factory = vi.fn();
      const service = new TranslationReconciliationService({
        database: database as never, queue: queue as never, providerFactory: factory,
        credentialReader: (p) => resolver.resolve({ environment, provider: p }),
        runtimeConfig: { current: () => backgroundRuntimeConfig() },
      });
      const failure = await service.reconcile().then(() => "unexpected success", (error: unknown) =>
        error instanceof Error ? error.message : String(error));
      expect(failure).toBe("Translation provider credential is unavailable");
      expect(factory).not.toHaveBeenCalled();
      expect(database.$executeRaw).not.toHaveBeenCalled();
      expect(failure).not.toContain(process.env.OPENAI_API_KEY);
      expect(failure).not.toContain(secret);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
      await db.commerceTranslationProviderCredential.deleteMany({ where: { environment, provider } });
      await db.platformAdmin.delete({ where: { id: admin.id } });
      await db.$disconnect();
    }
  });
});
