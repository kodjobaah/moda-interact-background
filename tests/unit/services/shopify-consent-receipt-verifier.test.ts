import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encryptCredential,
  parseCredentialKeyring,
} from "@modainteract/moda-interact-shared/security/credentials/node";
import { verifyShopifyConsentReceipt } from "../../../src/services/shopify-consent-receipt-verifier.js";
import type { ShopifyConsentReceiptAttribute } from "../../../src/domain/abandoned-checkout.js";

const shopId = "cm123456789012345678901234";
const cartToken = "cart-token";
const checkoutToken = "checkout-token";
const customerGid = "gid://shopify/Customer/12345";
const now = new Date("2026-11-18T03:00:00.000Z");
const keyringJson = JSON.stringify({
  "old-key": Buffer.alloc(32, 1).toString("base64"),
  "new-key": Buffer.alloc(32, 2).toString("base64"),
});

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function receipt(input: {
  kind?: "c" | "x";
  decision?: "G" | "R";
  shop?: string;
  binding?: string;
  customerId?: string;
  keyId?: "old-key" | "new-key";
} = {}): string {
  const kind = input.kind ?? "c";
  const expectedShop = input.shop ?? shopId;
  const bindingDigest = digest(input.binding ?? (kind === "c" ? cartToken : checkoutToken));
  const claims = [
    1,
    expectedShop,
    kind,
    bindingDigest,
    input.decision ?? "G",
    "1",
    "en-US",
    Math.floor(now.getTime() / 1000),
    input.customerId ?? "12345",
  ];
  const aad = JSON.stringify([
    "moda-shopify-wa-consent",
    1,
    expectedShop,
    kind,
    bindingDigest,
  ]);
  const keyring = parseCredentialKeyring(keyringJson);
  const envelope = encryptCredential({
    keyring,
    activeKeyId: input.keyId ?? "old-key",
    plaintext: JSON.stringify(claims),
    aad,
  });
  return [
    "v1",
    envelope.keyId,
    Buffer.from(envelope.nonce).toString("base64url"),
    Buffer.from(envelope.ciphertext).toString("base64url"),
    Buffer.from(envelope.authTag).toString("base64url"),
  ].join(".");
}

function verify(
  value: string,
  overrides: Partial<Parameters<typeof verifyShopifyConsentReceipt>[0]> = {},
) {
  return verifyShopifyConsentReceipt({
    attribute: { kind: "VALUE", value },
    shopId,
    shopifyPlus: false,
    cartToken: `${cartToken}?variant=1`,
    checkoutToken,
    verifiedShopifyCustomerId: customerGid,
    keyringJson,
    now,
    ...overrides,
  });
}

describe("Shopify checkout consent receipt verifier", () => {
  it("verifies the Shared AEAD receipt against authenticated base cart and customer", () => {
    expect(verify(receipt())).toMatchObject({
      status: "VERIFIED",
      decision: "GRANTED",
      customerId: "12345",
      kind: "c",
      locale: "en-US",
    });
  });

  it("reads a receipt encrypted with an old key while that key remains in the keyring", () => {
    expect(verify(receipt({ keyId: "old-key" })).status).toBe("VERIFIED");
  });

  it("verifies a newly issued key after rotation while the old key remains available", () => {
    expect(verify(receipt({ keyId: "new-key" })).status).toBe("VERIFIED");
    expect(verify(receipt({ keyId: "old-key" })).status).toBe("VERIFIED");
    const retiredKeyring = JSON.stringify({
      "new-key": Buffer.alloc(32, 2).toString("base64"),
    });
    expect(verify(receipt({ keyId: "old-key" }), { keyringJson: retiredKeyring }).status)
      .toBe("INVALID_OR_AMBIGUOUS_RECEIPT");
  });

  it("supports Plus checkout-token binding and revoke claims", () => {
    expect(verify(receipt({ kind: "x", decision: "R" }), {
      shopifyPlus: true,
    })).toMatchObject({ status: "VERIFIED", decision: "REVOKED", kind: "x" });
  });

  it("fails closed on copied shop, plan, cart, checkout and customer bindings", () => {
    expect(verify(receipt({ shop: "cm987654321098765432109876" })).status)
      .toBe("INVALID_OR_AMBIGUOUS_RECEIPT");
    expect(verify(receipt({ kind: "x" })).status).toBe("INVALID_OR_AMBIGUOUS_RECEIPT");
    expect(verify(receipt({ binding: "different-cart" })).status)
      .toBe("INVALID_OR_AMBIGUOUS_RECEIPT");
    expect(verify(receipt(), { cartToken: null }).status).toBe("DEFER_CHECKOUT_BINDING");
    expect(verify(receipt({ kind: "x" }), { shopifyPlus: true, checkoutToken: "" }).status)
      .toBe("DEFER_CHECKOUT_BINDING");
    expect(verify(receipt({ customerId: "12346" })).status)
      .toBe("DEFER_IDENTITY_OR_RECIPIENT");
  });

  it("accepts an explicitly signed guest only when Shopify reports no customer", () => {
    const guest = receipt({ customerId: "-" });
    expect(verify(guest, { verifiedShopifyCustomerId: null }).status).toBe("VERIFIED");
    expect(verify(guest).status).toBe("DEFER_IDENTITY_OR_RECIPIENT");
  });

  it("rejects malformed, duplicate, noncanonical and tampered attributes", () => {
    const valid = receipt();
    const fields = valid.split(".");
    fields[4] = `${fields[4]}=`;
    expect(verify(fields.join(".")).status).toBe("INVALID_OR_AMBIGUOUS_RECEIPT");
    expect(verify(`${valid}x`).status).toBe("INVALID_OR_AMBIGUOUS_RECEIPT");
    expect(verify(valid.replace(/.$/, valid.endsWith("A") ? "B" : "A")).status)
      .toBe("INVALID_OR_AMBIGUOUS_RECEIPT");
    expect(verify(valid, {
      attribute: { kind: "INVALID" },
    }).status).toBe("INVALID_OR_AMBIGUOUS_RECEIPT");
  });

  it("distinguishes no explicit choice from invalid receipt data", () => {
    expect(verifyShopifyConsentReceipt({
      attribute: { kind: "MISSING" },
      shopId,
      shopifyPlus: false,
      cartToken,
      checkoutToken,
      verifiedShopifyCustomerId: customerGid,
      keyringJson,
      now,
    })).toEqual({ status: "NO_EXPLICIT_CHOICE" });
  });

  it("fails closed when the keyring is unavailable or the future clock skew is excessive", () => {
    expect(verify(receipt(), { keyringJson: undefined }).status)
      .toBe("INVALID_OR_AMBIGUOUS_RECEIPT");
    const future = Math.floor(now.getTime() / 1000) + 301;
    const keyring = parseCredentialKeyring(keyringJson);
    const bindingDigest = digest(cartToken);
    const plaintext = JSON.stringify([1, shopId, "c", bindingDigest, "G", "1", "en-US", future, "12345"]);
    const aad = JSON.stringify(["moda-shopify-wa-consent", 1, shopId, "c", bindingDigest]);
    const envelope = encryptCredential({ keyring, activeKeyId: "new-key", plaintext, aad });
    const value = `v1.${envelope.keyId}.${Buffer.from(envelope.nonce).toString("base64url")}.${Buffer.from(envelope.ciphertext).toString("base64url")}.${Buffer.from(envelope.authTag).toString("base64url")}`;
    expect(verify(value).status).toBe("INVALID_OR_AMBIGUOUS_RECEIPT");
  });

  it("rejects an empty or malformed attribute without exposing receipt contents", () => {
    const empty: ShopifyConsentReceiptAttribute = { kind: "VALUE", value: "" };
    expect(verifyShopifyConsentReceipt({
      attribute: empty,
      shopId,
      shopifyPlus: false,
      cartToken,
      checkoutToken,
      verifiedShopifyCustomerId: customerGid,
      keyringJson,
      now,
    }).status).toBe("INVALID_OR_AMBIGUOUS_RECEIPT");
  });
});
