import { readFileSync } from "node:fs";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  createWooRestReadGrantAad,
  encryptCredential,
  parseCredentialKeyring,
  type CredentialKeyring,
} from "@modainteract/moda-interact-shared/security/credentials/node";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  WooCouponGrantService, loadWooCouponReadKeyring, loadWooCouponConnectionMode,
} from "../../../src/services/woo-coupon-grant.service.js";

const keyId = "woo-key-v1";
const secondKeyId = "woo-key-v2";
const key = Buffer.alloc(32, 17);
const secondKey = Buffer.alloc(32, 29);
const canonicalKeyring = parseCredentialKeyring(JSON.stringify({
  [keyId]: key.toString("base64"),
  [secondKeyId]: secondKey.toString("base64"),
}));
const shopId = "woo-shop";
const installationId = "install-a";
const attemptId = "attempt-a";

/** Same Shared call and persisted fields as API-002 sealWooReadCredentials. */
function sealed(activeKeyId = keyId, text = JSON.stringify(["ck_123", "cs_456"])) {
  const envelope = encryptCredential({
    keyring: canonicalKeyring,
    activeKeyId,
    plaintext: text,
    aad: createWooRestReadGrantAad({
      shopId, installationId, authorizationAttemptId: attemptId, credentialVersionSnapshot: 3,
    }),
  });
  return {
    encryptionKeyId: envelope.keyId,
    credentialCiphertext: Buffer.from(envelope.ciphertext),
    credentialNonce: Buffer.from(envelope.nonce),
    credentialAuthTag: Buffer.from(envelope.authTag),
  };
}

function harness(overrides: Record<string, unknown> = {}) {
  const installation = {
    id: installationId, shopId, status: "ACTIVE", revokedAt: null, canonicalSiteUrl: "https://woo.example",
    credentialVersion: 3,
    shop: { status: "ACTIVE", platform: "WOOCOMMERCE", shopifyShopId: null, domain: "https://woo.example" },
    restReadGrant: {
      id: "grant-a", installationId, shopId, status: "ACTIVE", revokedAt: null, invalidatedAt: null,
      authorizedScope: "read", authorizationAttemptId: attemptId, credentialVersionSnapshot: 3,
      rotationVersion: 1, encryptionKeyId: keyId, ...sealed(),
    },
  };
  const findUnique = vi.fn().mockResolvedValue({ ...installation, ...overrides });
  const database = { wooCommerceInstallation: { findUnique } } as unknown as PrismaClient;
  return { findUnique, service: new WooCouponGrantService(database, canonicalKeyring, "public") };
}

describe("ARCH-039 Shared Woo grant reader parity", () => {
  it("opens the exact API-002 Shared AAD and rechecks the grant after I/O", async () => {
    const h = harness();
    const read = vi.fn().mockResolvedValue([{ id: 10 }]);
    expect(await h.service.withAuthorizedRead(shopId, read)).toEqual([{ id: 10 }]);
    expect(read).toHaveBeenCalledWith(
      { canonicalSiteUrl: "https://woo.example", mode: "public" },
      { consumerKey: "ck_123", consumerSecret: "cs_456" },
    );
    expect(h.findUnique).toHaveBeenCalledTimes(2);
  });

  it("decrypts with a retained non-active key without an active writer selector", async () => {
    const h = harness();
    const installation = await h.findUnique();
    h.findUnique.mockResolvedValue({
      ...installation,
      restReadGrant: {
        ...installation.restReadGrant,
        ...sealed(secondKeyId),
      },
    });
    const read = vi.fn().mockResolvedValue("rotated");
    expect(await h.service.withAuthorizedRead(shopId, read)).toBe("rotated");
    expect(read).toHaveBeenCalledWith(
      { canonicalSiteUrl: "https://woo.example", mode: "public" },
      { consumerKey: "ck_123", consumerSecret: "cs_456" },
    );
  });

  it("rejects modified tags, incorrect key IDs and malformed decrypted JSON", async () => {
    for (const grant of [
      { credentialAuthTag: Buffer.alloc(16, 0) },
      { encryptionKeyId: "missing-key" },
      { ...sealed(keyId, JSON.stringify(["ck_123"])) },
      { ...sealed(keyId, JSON.stringify(["ck_123", "cs\n456"])) },
    ]) {
      const h = harness();
      const installation = await h.findUnique();
      h.findUnique.mockResolvedValue({ ...installation, restReadGrant: { ...installation.restReadGrant, ...grant } });
      const read = vi.fn();
      await expect(h.service.withAuthorizedRead(shopId, read)).rejects.toThrow("grant_unavailable");
      expect(read).not.toHaveBeenCalled();
    }
  });

  it("rejects invalid durable rotation versions before calling the provider", async () => {
    for (const rotationVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const h = harness();
      const installation = await h.findUnique();
      h.findUnique.mockResolvedValue({
        ...installation,
        restReadGrant: { ...installation.restReadGrant, rotationVersion },
      });
      const read = vi.fn();
      await expect(h.service.withAuthorizedRead(shopId, read)).rejects.toThrow("grant_unavailable");
      expect(read).not.toHaveBeenCalled();
    }
  });

  it("accepts an independently sealed API-format envelope using canonical Shared AAD", async () => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(createWooRestReadGrantAad({
      shopId, installationId, authorizationAttemptId: attemptId, credentialVersionSnapshot: 3,
    })));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(["ck_123", "cs_456"])), cipher.final()]);
    const h = harness();
    const installation = await h.findUnique();
    h.findUnique.mockResolvedValue({
      ...installation,
      restReadGrant: {
        ...installation.restReadGrant,
        credentialNonce: nonce,
        credentialCiphertext: ciphertext,
        credentialAuthTag: cipher.getAuthTag(),
      },
    });
    expect(await h.service.withAuthorizedRead(shopId, async (_site, credential) => credential.consumerKey))
      .toBe("ck_123");
  });

  it("skips absent permission and never invokes the provider", async () => {
    const h = harness({ restReadGrant: null });
    const read = vi.fn();
    await expect(h.service.withAuthorizedRead(shopId, read)).rejects.toThrow("grant_missing");
    expect(read).not.toHaveBeenCalled();
  });

  it("fails closed for wrong AAD, missing key and revocation during I/O", async () => {
    const h = harness();
    const current = await h.findUnique();
    h.findUnique.mockResolvedValue({ ...current, restReadGrant: { ...current.restReadGrant, authorizationAttemptId: "wrong" } });
    await expect(h.service.withAuthorizedRead(shopId, vi.fn())).rejects.toThrow("grant_unavailable");

    const revoked = harness();
    const original = await revoked.findUnique();
    revoked.findUnique.mockResolvedValueOnce(original).mockResolvedValueOnce({
      ...original, restReadGrant: { ...original.restReadGrant, status: "REVOKED" },
    });
    await expect(revoked.service.withAuthorizedRead(shopId, async () => [])).rejects.toThrow("grant_changed");
  });

  it("rejects partial/invalid keyring and forbids local mode in production", () => {
    expect(() => loadWooCouponReadKeyring({})).toThrow("grant_configuration");
    expect(() => loadWooCouponReadKeyring({ COMMERCE_CONNECTION_KEYS_JSON: "{}" })).toThrow("grant_configuration");
    const parsed = loadWooCouponReadKeyring({
      COMMERCE_CONNECTION_KEYS_JSON: JSON.stringify({ [keyId]: key.toString("base64") }),
    });
    expect(parsed.hasKey(keyId)).toBe(true);
    expect(parsed.keyIds).toEqual([keyId]);
    expect(() => loadWooCouponReadKeyring({
      // Legacy-only configuration is forbidden (no alias or fallback).
      MODA_WOO_REST_READ_KEYRING: JSON.stringify({ [keyId]: key.toString("base64url") }),
    } as NodeJS.ProcessEnv)).toThrow("grant_configuration");
    expect(() => loadWooCouponReadKeyring({
      COMMERCE_CONNECTION_KEYS_JSON: JSON.stringify({ [keyId]: key.toString("base64url") }),
    })).toThrow("grant_configuration");
    expect(() => loadWooCouponConnectionMode({ MODA_WOOCOMMERCE_CONNECTION_MODE: "local-development", NODE_ENV: "production" })).toThrow("grant_configuration");
  });
});

// Immutable independent producer fixture from the earlier API-007 AES-GCM grant.
// It exercises the same persisted AES-GCM wire shape; API-002 Shared-generated
// grants are covered above, including active-key rotation and tampering.
const apiFixture = JSON.parse(
  readFileSync(new URL("../../fixtures/arch036-api007-sealed-grant.json", import.meta.url), "utf8"),
) as {
  context: { shopId: string; installationId: string; authorizationAttemptId: string; credentialVersionSnapshot: number };
  keyId: string;
  rotationVersion: number;
  ciphertext: string;
  nonce: string;
  authTag: string;
};

function producerFixture(overrides: {
  installation?: Record<string, unknown>;
  grant?: Record<string, unknown>;
  keyring?: CredentialKeyring;
} = {}) {
  const original = {
    id: apiFixture.context.installationId,
    shopId: apiFixture.context.shopId,
    status: "ACTIVE", revokedAt: null,
    canonicalSiteUrl: "https://woo.example", credentialVersion: apiFixture.context.credentialVersionSnapshot,
    shop: { status: "ACTIVE", platform: "WOOCOMMERCE", shopifyShopId: null, domain: "https://woo.example" },
    restReadGrant: {
      id: "fixture-grant", installationId: apiFixture.context.installationId,
      shopId: apiFixture.context.shopId,
      status: "ACTIVE", revokedAt: null, invalidatedAt: null, authorizedScope: "read",
      authorizationAttemptId: apiFixture.context.authorizationAttemptId,
      credentialVersionSnapshot: apiFixture.context.credentialVersionSnapshot,
      rotationVersion: apiFixture.rotationVersion, encryptionKeyId: apiFixture.keyId,
      credentialCiphertext: Buffer.from(apiFixture.ciphertext, "base64"),
      credentialNonce: Buffer.from(apiFixture.nonce, "base64"),
      credentialAuthTag: Buffer.from(apiFixture.authTag, "base64"),
    },
  };
  const installation = { ...original, ...overrides.installation,
    restReadGrant: { ...original.restReadGrant, ...overrides.grant } };
  const findUnique = vi.fn().mockResolvedValue(installation);
  const db = { wooCommerceInstallation: { findUnique } } as unknown as PrismaClient;
  return { findUnique, installation, service: new WooCouponGrantService(db,
    overrides.keyring ?? parseCredentialKeyring(JSON.stringify({
      [apiFixture.keyId]: key.toString("base64"),
    })), "public") };
}

describe("ARCH-036 API-007 producer-sealed credential fixture", () => {
  it("opens the immutable API-produced fixture and rechecks the installation", async () => {
    const h = producerFixture();
    const provider = vi.fn().mockResolvedValue("ok");
    expect(await h.service.withAuthorizedRead(apiFixture.context.shopId, provider)).toBe("ok");
    expect(provider).toHaveBeenCalledWith(
      { canonicalSiteUrl: "https://woo.example", mode: "public" },
      { consumerKey: "ck_123", consumerSecret: "cs_456" },
    );
    expect(h.findUnique).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing key ID", { grant: { encryptionKeyId: "other-key" } }],
    ["incorrect key bytes", { keyring: parseCredentialKeyring(JSON.stringify({
      [apiFixture.keyId]: Buffer.alloc(32, 44).toString("base64"),
    })) }],
    ["installation AAD", { installation: { id: "wrong-installation" }, grant: { installationId: "wrong-installation" } }],
    ["attempt AAD", { grant: { authorizationAttemptId: "wrong-attempt" } }],
    ["credential-version AAD", { installation: { credentialVersion: 4 }, grant: { credentialVersionSnapshot: 4 } }],
    ["wrong tenant", { installation: { shopId: "other-shop" } }],
    ["write scope", { grant: { authorizedScope: "read_write" } }],
    ["revoked grant", { grant: { status: "REVOKED" } }],
  ])("rejects %s without calling provider", async (_name, overrides) => {
    const h = producerFixture(overrides);
    const provider = vi.fn();
    await expect(h.service.withAuthorizedRead(apiFixture.context.shopId, provider)).rejects.toThrow();
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects altered shop-bound AAD even when row identity is otherwise consistent", async () => {
    const newShopId = "woo-other-shop";
    const h = producerFixture({
      installation: { shopId: newShopId },
      grant: { shopId: newShopId },
    });
    const provider = vi.fn();
    await expect(h.service.withAuthorizedRead(newShopId, provider)).rejects.toThrow("grant_unavailable");
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects grant rotation that occurs during the provider read", async () => {
    const h = producerFixture();
    h.findUnique.mockResolvedValueOnce(h.installation).mockResolvedValueOnce({
      ...h.installation,
      restReadGrant: { ...(h.installation.restReadGrant as object), rotationVersion: 2 },
    });
    await expect(h.service.withAuthorizedRead(apiFixture.context.shopId, async () => []))
      .rejects.toThrow("grant_changed");
  });
});
