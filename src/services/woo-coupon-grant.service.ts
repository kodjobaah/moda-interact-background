import type { PrismaClient } from "@prisma/client";

import { readCommerceCredentialKeyring } from "../commerce/credential-keyring.js";
import prisma from "../lib/db.js";
import { decryptEncryptedCredential } from "../security/aes-gcm-credential.js";
import { WooCouponReadError, type WooCouponSite } from "../providers/woo-coupon-transport.js";

export interface WooCouponCredential {
  consumerKey: string;
  consumerSecret: string;
}

export type WooConnectionMode = "public" | "local-development";
export type WooCouponGrantDatabase = Pick<PrismaClient, "wooCommerceInstallation">;

function loadWooCouponGrantKeyring(): Readonly<Record<string, Uint8Array>> {
  try {
    return readCommerceCredentialKeyring();
  } catch {
    throw new WooCouponReadError("grant_configuration");
  }
}

export function loadWooCouponConnectionMode(environment: NodeJS.ProcessEnv = process.env): WooConnectionMode {
  const value = environment.MODA_WOOCOMMERCE_CONNECTION_MODE?.trim() || "public";
  if (value !== "public" && value !== "local-development") throw new WooCouponReadError("grant_configuration");
  if (value === "local-development" && environment.NODE_ENV === "production") {
    throw new WooCouponReadError("grant_configuration");
  }
  return value;
}

const installationSelection = {
  id: true, shopId: true, canonicalSiteUrl: true, credentialVersion: true,
  status: true, revokedAt: true,
  shop: { select: { status: true, platform: true, shopifyShopId: true, domain: true } },
  restReadGrant: { select: {
    id: true, installationId: true, shopId: true, status: true, revokedAt: true, invalidatedAt: true,
    authorizedScope: true, authorizationAttemptId: true, credentialVersionSnapshot: true,
    rotationVersion: true, credentialCiphertext: true, credentialNonce: true,
    credentialAuthTag: true, encryptionKeyId: true,
  } },
} as const;

/** Permission is checked when the job executes, not during installation discovery. */
export class WooCouponGrantService {
  constructor(
    private readonly database: WooCouponGrantDatabase = prisma,
    private readonly keys: Readonly<Record<string, Uint8Array>> = loadWooCouponGrantKeyring(),
    private readonly mode: WooConnectionMode = loadWooCouponConnectionMode(),
  ) {}

  async withAuthorizedRead<T>(
    shopId: string,
    read: (site: WooCouponSite, credential: WooCouponCredential) => Promise<T>,
  ): Promise<T> {
    if (typeof shopId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(shopId)) {
      throw new WooCouponReadError("shop_unavailable");
    }
    const before = await this.load(shopId);
    const grant = before?.restReadGrant;
    if (!before || !this.eligible(before, shopId)) throw new WooCouponReadError("shop_unavailable");
    if (!grant || grant.status !== "ACTIVE" || grant.revokedAt !== null || grant.invalidatedAt !== null ||
        grant.shopId !== shopId || grant.installationId !== before.id ||
        grant.authorizedScope !== "read" || grant.credentialVersionSnapshot !== before.credentialVersion) {
      throw new WooCouponReadError("grant_missing");
    }
    const site = { canonicalSiteUrl: before.canonicalSiteUrl, mode: this.mode } as const;
    let credential: WooCouponCredential;
    try {
      const value = decryptEncryptedCredential({
        envelope: {
          keyId: grant.encryptionKeyId,
          editVersion: grant.rotationVersion,
          ciphertext: grant.credentialCiphertext,
          nonce: grant.credentialNonce,
          authTag: grant.credentialAuthTag,
        },
        key: this.keys[grant.encryptionKeyId],
        aad: JSON.stringify([
          "moda-woo-rest-read-v1", shopId, before.id,
          grant.authorizationAttemptId, grant.credentialVersionSnapshot,
        ]),
      });
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed) || parsed.length !== 2 ||
          !parsed.every((item) => typeof item === "string" && item.length > 0 && item.length <= 256 &&
            !/[\r\n\0:]/.test(item))) throw new Error("invalid");
      credential = { consumerKey: parsed[0] as string, consumerSecret: parsed[1] as string };
    } catch {
      throw new WooCouponReadError("grant_unavailable");
    }
    const result = await read(site, credential);
    // Grant status or installation identity may change during slow paginated reads.
    const after = await this.load(shopId);
    if (!after || !this.eligible(after, shopId) ||
        after.id !== before.id || after.canonicalSiteUrl !== before.canonicalSiteUrl ||
        after.credentialVersion !== before.credentialVersion ||
        after.restReadGrant?.id !== grant.id || after.restReadGrant.status !== "ACTIVE" ||
        after.restReadGrant.revokedAt !== null || after.restReadGrant.invalidatedAt !== null ||
        after.restReadGrant.authorizationAttemptId !== grant.authorizationAttemptId ||
        after.restReadGrant.rotationVersion !== grant.rotationVersion ||
        after.restReadGrant.credentialVersionSnapshot !== grant.credentialVersionSnapshot ||
        after.restReadGrant.authorizedScope !== "read") {
      throw new WooCouponReadError("grant_changed");
    }
    return result;
  }

  private load(shopId: string) {
    return this.database.wooCommerceInstallation.findUnique({ where: { shopId }, select: installationSelection });
  }

  private eligible(installation: NonNullable<Awaited<ReturnType<WooCouponGrantService["load"]>>>, shopId: string) {
    return installation.shopId === shopId && installation.status === "ACTIVE" &&
      installation.revokedAt === null && installation.shop.status === "ACTIVE" &&
      installation.shop.platform === "WOOCOMMERCE" && installation.shop.shopifyShopId === null &&
      installation.shop.domain === installation.canonicalSiteUrl;
  }
}
