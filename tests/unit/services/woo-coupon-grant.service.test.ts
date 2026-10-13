import { createCipheriv, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  WooCouponGrantService, loadWooCouponReadKeyring, loadWooCouponConnectionMode,
} from "../../../src/services/woo-coupon-grant.service.js";

const keyId = "k".repeat(70); // API-007 accepts key IDs up to 128 characters.
const key = Buffer.alloc(32, 17);
const shopId = "woo-shop";
const installationId = "install-a";
const attemptId = "attempt-a";

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
  return { findUnique, service: new WooCouponGrantService(database, new Map([[keyId, key]]), "public") };
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

  it("rejects partial/invalid keyring and forbids local mode in production", () => {
    expect(() => loadWooCouponReadKeyring({ MODA_WOO_REST_READ_KEYRING: "{}" })).toThrow("grant_configuration");
    expect(loadWooCouponReadKeyring({ MODA_WOO_REST_READ_KEYRING: JSON.stringify({ [keyId]: key.toString("base64url") }) }).get(keyId)).toEqual(key);
    expect(() => loadWooCouponConnectionMode({ MODA_WOOCOMMERCE_CONNECTION_MODE: "local-development", NODE_ENV: "production" })).toThrow("grant_configuration");
  });
});
