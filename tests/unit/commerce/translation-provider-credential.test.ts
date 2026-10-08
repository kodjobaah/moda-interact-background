import { createCipheriv } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createCommerceTranslationProviderCredentialAad } from "@modainteract/moda-interact-shared/commerce/model";
import { describe, expect, it, vi } from "vitest";

import { createTranslationProviderCredentialResolver } from "../../../src/commerce/translation-provider-credential.js";

const key = Buffer.alloc(32, 17);
const keyring = { active: key };

function seal(credential: string) {
  const nonce = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(createCommerceTranslationProviderCredentialAad({
    environment: "DEVELOPMENT",
    provider: "openai",
    keyId: "active",
  }), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(credential, "utf8")),
    cipher.final(),
  ]);
  return {
    id: "translation-credential-row",
    environment: "DEVELOPMENT",
    provider: "openai",
    keyId: "active",
    editVersion: 1,
    ciphertext,
    nonce,
    authTag: cipher.getAuthTag(),
    updatedByAdminId: "admin-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("translation provider credential decryption", () => {
  it("decrypts the Shared translation-provider AAD envelope", async () => {
    const findUnique = vi.fn(async () => seal("translation-key"));
    const db = {
      commerceTranslationProviderCredential: { findUnique },
    } as unknown as PrismaClient;
    const resolver = createTranslationProviderCredentialResolver({ db, keyring });

    await expect(resolver.resolve({
      environment: "DEVELOPMENT",
      provider: "openai",
    })).resolves.toBe("translation-key");
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        environment_provider: {
          environment: "DEVELOPMENT",
          provider: "openai",
        },
      },
    });
  });

  it("binds ciphertext to provider identity", async () => {
    const row = seal("translation-key");
    const db = {
      commerceTranslationProviderCredential: {
        findUnique: vi.fn(async () => ({ ...row, provider: "deepl" })),
      },
    } as unknown as PrismaClient;
    const resolver = createTranslationProviderCredentialResolver({ db, keyring });

    await expect(resolver.resolve({
      environment: "DEVELOPMENT",
      provider: "deepl",
    })).rejects.toThrow("Translation provider credential is unavailable");
  });

  it("rejects a valid-looking row whose ciphertext is bound to another provider", async () => {
    const db = {
      commerceTranslationProviderCredential: {
        findUnique: vi.fn(async () => ({ ...seal("translation-key"), provider: "deepl" })),
      },
    } as unknown as PrismaClient;
    const resolver = createTranslationProviderCredentialResolver({ db, keyring });

    await expect(resolver.resolve({
      environment: "DEVELOPMENT",
      provider: "deepl",
    })).rejects.toThrow("Translation provider credential is unavailable");
  });

  it("fails bounded for missing or malformed encrypted state", async () => {
    const db = {
      commerceTranslationProviderCredential: {
        findUnique: vi.fn(async () => ({ ...seal("translation-key"), authTag: Buffer.alloc(15) })),
      },
    } as unknown as PrismaClient;
    const resolver = createTranslationProviderCredentialResolver({ db, keyring });

    await expect(resolver.resolve({
      environment: "DEVELOPMENT",
      provider: "openai",
    })).rejects.toThrow("Translation provider credential is unavailable");
  });
});
