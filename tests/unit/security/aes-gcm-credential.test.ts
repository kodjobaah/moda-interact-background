import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  decryptEncryptedCredential,
  isValidEncryptedCredentialEnvelope,
  isValidEncryptedCredentialKey,
  type EncryptedCredentialEnvelope,
} from "../../../src/security/aes-gcm-credential.js";

const key = Buffer.alloc(32, 29);
const aad = "commerce-credential:test";
const UNAVAILABLE = "Encrypted credential is unavailable";

function seal(plaintext: Uint8Array): EncryptedCredentialEnvelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    keyId: "active",
    editVersion: 1,
    ciphertext,
    nonce,
    authTag: cipher.getAuthTag(),
  };
}

const decrypt = (envelope: EncryptedCredentialEnvelope, suppliedKey: unknown = key, boundAad = aad) =>
  decryptEncryptedCredential({ envelope, key: suppliedKey, aad: boundAad });

describe("AES-256-GCM encrypted credential boundary", () => {
  it("decrypts a well-formed envelope using its exact key and AAD", () => {
    const envelope = seal(Buffer.from("valid-é-credential", "utf8"));
    expect(isValidEncryptedCredentialEnvelope(envelope)).toBe(true);
    expect(isValidEncryptedCredentialKey(key)).toBe(true);
    expect(decrypt(envelope)).toBe("valid-é-credential");
  });

  it.each([
    ["missing envelope", null],
    ["blank key id", { ...seal(Buffer.from("secret")), keyId: "  " }],
    ["long key id", { ...seal(Buffer.from("secret")), keyId: "k".repeat(65) }],
    ["zero edit version", { ...seal(Buffer.from("secret")), editVersion: 0 }],
    ["fractional edit version", { ...seal(Buffer.from("secret")), editVersion: 1.5 }],
    ["unsafe edit version", { ...seal(Buffer.from("secret")), editVersion: Number.MAX_SAFE_INTEGER + 1 }],
    ["empty ciphertext", { ...seal(Buffer.from("secret")), ciphertext: Buffer.alloc(0) }],
    ["non-byte ciphertext", { ...seal(Buffer.from("secret")), ciphertext: "ciphertext" }],
    ["oversized ciphertext", { ...seal(Buffer.from("secret")), ciphertext: Buffer.alloc(8193) }],
    ["short nonce", { ...seal(Buffer.from("secret")), nonce: Buffer.alloc(11) }],
    ["short tag", { ...seal(Buffer.from("secret")), authTag: Buffer.alloc(15) }],
  ])("rejects a %s as an invalid envelope", (_label, envelope) => {
    expect(isValidEncryptedCredentialEnvelope(envelope)).toBe(false);
  });

  it("rejects absent, malformed and wrong keys", () => {
    const envelope = seal(Buffer.from("secret"));
    expect(() => decryptEncryptedCredential({ envelope, key: undefined, aad })).toThrow(UNAVAILABLE);
    for (const candidate of [null, Buffer.alloc(31), Buffer.alloc(32, 7), { byteLength: 32 }]) {
      expect(() => decrypt(envelope, candidate)).toThrow(UNAVAILABLE);
    }
    expect(isValidEncryptedCredentialKey(Buffer.alloc(31))).toBe(false);
    expect(isValidEncryptedCredentialKey({ byteLength: 32 })).toBe(false);
  });

  it("authenticates both AAD identity and authentication tag", () => {
    const envelope = seal(Buffer.from("secret"));
    expect(() => decrypt(envelope, key, "other-environment")).toThrow(UNAVAILABLE);
    const corruptedTag = Buffer.from(envelope.authTag);
    corruptedTag[0] ^= 0xff;
    expect(() => decrypt({ ...envelope, authTag: corruptedTag })).toThrow(UNAVAILABLE);
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["carriage return", Buffer.from("a\rb")],
    ["line feed", Buffer.from("a\nb")],
    ["NUL", Buffer.from("a\0b")],
    ["invalid UTF-8", Buffer.from([0xc3, 0x28])],
    ["oversized plaintext", Buffer.alloc(8193, 0x61)],
  ])("fails closed on %s decrypted plaintext", (_label, plaintext) => {
    expect(() => decrypt(seal(plaintext))).toThrow(UNAVAILABLE);
  });
});
