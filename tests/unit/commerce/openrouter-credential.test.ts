import { createCipheriv } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createCommerceOpenRouterCredentialAad } from "@modainteract/moda-interact-shared/commerce/model";
import { describe, expect, it, vi } from "vitest";
import { createOpenRouterCredentialResolver } from "../../../src/commerce/openrouter-credential.js";

const key = Buffer.alloc(32, 11);
const keyring = { active: key };

function seal(credential: string) {
  const nonce = Buffer.alloc(12, 5);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(createCommerceOpenRouterCredentialAad({
    environment: "DEVELOPMENT",
    keyId: "active",
  }), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(credential, "utf8")),
    cipher.final(),
  ]);
  return {
    id: "credential-row",
    environment: "DEVELOPMENT",
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

function resolver(row: unknown) {
  const findUnique = vi.fn(async () => row);
  const db = {
    commerceOpenRouterCredential: { findUnique },
  } as unknown as PrismaClient;
  return {
    credentialResolver: createOpenRouterCredentialResolver({ db, keyring }),
    findUnique,
  };
}

const resolve = (credentialResolver: ReturnType<typeof createOpenRouterCredentialResolver>) =>
  credentialResolver.resolve({
    environment: "DEVELOPMENT",
    signal: new AbortController().signal,
  });

describe("OpenRouter credential decryption", () => {
  it("decrypts the Shared AAD-compatible AES-256-GCM envelope", async () => {
    const { credentialResolver, findUnique } = resolver(seal("credential-A"));
    await expect(resolve(credentialResolver)).resolves.toBe("credential-A");
    expect(findUnique).toHaveBeenCalledWith({ where: { environment: "DEVELOPMENT" } });
  });

  it.each([
    ["missing row", null, keyring],
    ["missing key id", seal("credential-A"), {}],
    ["short key", seal("credential-A"), { active: Buffer.alloc(16) }],
    ["short nonce", { ...seal("credential-A"), nonce: Buffer.alloc(11) }, keyring],
    ["short tag", { ...seal("credential-A"), authTag: Buffer.alloc(15) }, keyring],
    ["empty ciphertext", { ...seal("credential-A"), ciphertext: Buffer.alloc(0) }, keyring],
    ["oversized ciphertext", { ...seal("credential-A"), ciphertext: Buffer.alloc(8193) }, keyring],
    ["invalid key id", { ...seal("credential-A"), keyId: " " }, keyring],
  ])("fails bounded for %s", async (_label, row, suppliedKeyring) => {
    const findUnique = vi.fn(async () => row);
    const db = { commerceOpenRouterCredential: { findUnique } } as unknown as PrismaClient;
    const credentialResolver = createOpenRouterCredentialResolver({
      db,
      keyring: suppliedKeyring,
    });
    await expect(resolve(credentialResolver)).rejects.toThrow(
      "OpenRouter credential is unavailable",
    );
  });

  it("maps authentication-tag failures without exposing crypto details", async () => {
    const row = seal("credential-A");
    row.authTag[0] ^= 0xff;
    const { credentialResolver } = resolver(row);
    await expect(resolve(credentialResolver)).rejects.toThrow(
      "OpenRouter credential is unavailable",
    );
  });

  it.each(["", "line\nbreak", "carriage\rreturn", "nul\0byte"])(
    "rejects invalid plaintext %j",
    async (plaintext) => {
      const { credentialResolver } = resolver(seal(plaintext));
      await expect(resolve(credentialResolver)).rejects.toThrow(
        "OpenRouter credential is unavailable",
      );
    },
  );

  it("fails immediately when cancelled without querying the database", async () => {
    const { credentialResolver, findUnique } = resolver(seal("credential-A"));
    const controller = new AbortController();
    controller.abort();
    await expect(credentialResolver.resolve({
      environment: "DEVELOPMENT",
      signal: controller.signal,
    })).rejects.toThrow("OpenRouter credential is unavailable");
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("maps database failures to the same bounded error", async () => {
    const db = {
      commerceOpenRouterCredential: {
        findUnique: vi.fn(async () => { throw new Error("secret database detail"); }),
      },
    } as unknown as PrismaClient;
    const credentialResolver = createOpenRouterCredentialResolver({ db, keyring });
    await expect(resolve(credentialResolver)).rejects.toThrow(
      "OpenRouter credential is unavailable",
    );
  });
});