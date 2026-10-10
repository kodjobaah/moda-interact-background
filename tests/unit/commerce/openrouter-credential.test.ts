import { createCipheriv } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createCommerceOpenRouterCredentialAad } from "@modainteract/moda-interact-shared/commerce/model";
import { describe, expect, it, vi } from "vitest";
import { createOpenRouterCredentialResolver } from "../../../src/commerce/openrouter-credential.js";
import { OpenRouterCredentialResolutionFailure } from "../../../src/commerce/openrouter-credential-failure.js";

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
    ["missing row", null, keyring, "CREDENTIAL_NOT_CONFIGURED"],
    ["missing key id", seal("credential-A"), {}, "CREDENTIAL_KEY_MISSING"],
    ["short key", seal("credential-A"), { active: Buffer.alloc(16) }, "CREDENTIAL_KEY_INVALID"],
    ["short nonce", { ...seal("credential-A"), nonce: Buffer.alloc(11) }, keyring, "CREDENTIAL_ENVELOPE_INVALID"],
    ["short tag", { ...seal("credential-A"), authTag: Buffer.alloc(15) }, keyring, "CREDENTIAL_ENVELOPE_INVALID"],
    ["empty ciphertext", { ...seal("credential-A"), ciphertext: Buffer.alloc(0) }, keyring, "CREDENTIAL_ENVELOPE_INVALID"],
    ["oversized ciphertext", { ...seal("credential-A"), ciphertext: Buffer.alloc(8193) }, keyring, "CREDENTIAL_ENVELOPE_INVALID"],
    ["invalid key id", { ...seal("credential-A"), keyId: " " }, keyring, "CREDENTIAL_ENVELOPE_INVALID"],
    ["unsafe edit version", { ...seal("credential-A"), editVersion: Number.MAX_SAFE_INTEGER + 1 }, keyring, "CREDENTIAL_ENVELOPE_INVALID"],
  ])("fails bounded for %s", async (_label, row, suppliedKeyring, reasonCode) => {
    const findUnique = vi.fn(async () => row);
    const db = { commerceOpenRouterCredential: { findUnique } } as unknown as PrismaClient;
    const credentialResolver = createOpenRouterCredentialResolver({
      db,
      keyring: suppliedKeyring,
    });
    await expect(resolve(credentialResolver)).rejects.toMatchObject({
      message: "OpenRouter credential is unavailable",
      reasonCode,
      reasonMessage: expect.any(String),
      operatorAction: expect.any(String),
    });
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

describe("credential failure provenance", () => {
  it("identifies decryption failures without exposing authentication-tag details", async () => {
    const row = seal("credential-A");
    row.authTag[0] ^= 0xff;
    const { credentialResolver } = resolver(row);
    await expect(resolve(credentialResolver)).rejects.toMatchObject({
      reasonCode: "CREDENTIAL_DECRYPTION_FAILED",
      reasonMessage: expect.stringContaining("rejected the stored value during authenticated decoding"),
    });
  });

  it("identifies a returned row for a different environment", async () => {
    const { credentialResolver } = resolver({ ...seal("credential-A"), environment: "PRODUCTION" });
    await expect(resolve(credentialResolver)).rejects.toMatchObject({
      reasonCode: "CREDENTIAL_ENVIRONMENT_MISMATCH",
    });
  });

  it("identifies a cancelled lookup and preserves a safe message", async () => {
    const { credentialResolver } = resolver(seal("credential-A"));
    const controller = new AbortController();
    controller.abort();
    await expect(credentialResolver.resolve({
      environment: "DEVELOPMENT",
      signal: controller.signal,
    })).rejects.toMatchObject({ reasonCode: "CREDENTIAL_SIGNAL_ABORTED" });
  });

  it("preserves the underlying database error internally, not in safe diagnostic fields", async () => {
    const db = {
      commerceOpenRouterCredential: {
        findUnique: vi.fn(async () => { throw new Error("secret SQL connection string"); }),
      },
    } as unknown as PrismaClient;
    const credentialResolver = createOpenRouterCredentialResolver({ db, keyring });
    let caught: unknown;
    try { await resolve(credentialResolver); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(OpenRouterCredentialResolutionFailure);
    const failure = caught as OpenRouterCredentialResolutionFailure;
    expect(failure.reasonCode).toBe("CREDENTIAL_LOOKUP_FAILED");
    expect(failure.cause).toBeInstanceOf(Error);
    expect(`${failure.reasonMessage} ${failure.operatorAction}`).not.toContain("secret SQL");
    expect(JSON.stringify({ reasonCode: failure.reasonCode, message: failure.reasonMessage })).not.toContain("secret SQL");
  });
});
