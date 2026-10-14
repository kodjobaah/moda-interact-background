import { readFileSync } from "node:fs";
import { createCipheriv, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WooCouponGrantService, loadWooCouponConnectionMode,
} from "../../../src/services/woo-coupon-grant.service.js";

const keyId = "k".repeat(70); // API-007 accepts key IDs up to 128 characters.
const key = Buffer.alloc(32, 17);
const shopId = "woo-shop";
const installationId = "install-a";
const attemptId = "attempt-a";
const keyring = { [keyId]: key };

afterEach(() => vi.unstubAllEnvs());

function sealed() {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(["moda-woo-rest-read-v1", shopId, installationId, attemptId, 3])));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(["ck_123", "cs_456"])), cipher.final()]);
  return { credentialCiphertext: ciphertext, credentialNonce: nonce, credentialAuthTag: cipher.getAuthTag() };
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
  return { findUnique, service: new WooCouponGrantService(database, keyring, "public") };
}

describe("ARCH-036 API-sealed read grant parity", () => {
  it("opens the exact API-007 AAD and rechecks the grant after I/O", async () => {
    const h = harness();
    const read = vi.fn().mockResolvedValue([{ id: 10 }]);
    expect(await h.service.withAuthorizedRead(shopId, read)).toEqual([{ id: 10 }]);
    expect(read).toHaveBeenCalledWith(
      { canonicalSiteUrl: "https://woo.example", mode: "public" },
      { consumerKey: "ck_123", consumerSecret: "cs_456" },
    );
    expect(h.findUnique).toHaveBeenCalledTimes(2);
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

  it("uses the shared Commerce keyring and forbids local mode in production", () => {
    vi.stubEnv("COMMERCE_CONNECTION_KEYS_JSON", "{}");
    expect(() => new WooCouponGrantService(
      { wooCommerceInstallation: { findUnique: vi.fn() } } as unknown as PrismaClient,
    )).toThrow("grant_configuration");
    vi.stubEnv("COMMERCE_CONNECTION_KEYS_JSON", JSON.stringify({ [keyId]: key.toString("base64") }));
    const service = new WooCouponGrantService(
      { wooCommerceInstallation: { findUnique: vi.fn() } } as unknown as PrismaClient,
      undefined,
      "public",
    );
    expect(service).toBeInstanceOf(WooCouponGrantService);
    expect(() => loadWooCouponConnectionMode({ MODA_WOOCOMMERCE_CONNECTION_MODE: "local-development", NODE_ENV: "production" })).toThrow("grant_configuration");
  });
});

// Immutable cross-repository fixture: generated using API-007's
// moda-interact-api/src/woocommerce/rest-read/envelope.ts sealWooReadCredentials.
// This is intentionally NOT created using Background's own sealing helper.
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
  keys?: Readonly<Record<string, Uint8Array>>;
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
    overrides.keys ?? { [apiFixture.keyId]: Buffer.alloc(32, 17) }, "public") };
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
    ["incorrect key bytes", { keys: { [apiFixture.keyId]: Buffer.alloc(32, 44) } }],
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
