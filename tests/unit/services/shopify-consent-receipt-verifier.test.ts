import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

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

  it("accepts an authenticated guest receipt after Shopify later associates a customer", () => {
    const guest = receipt({ customerId: "-" });
    expect(verify(guest, { verifiedShopifyCustomerId: null }).status).toBe("VERIFIED");
    expect(verify(guest).status).toBe("VERIFIED");
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
      .toBe("KEYRING_CONFIGURATION_FAILURE");
    const future = Math.floor(now.getTime() / 1000) + 301;
    const keyring = parseCredentialKeyring(keyringJson);
    const bindingDigest = digest(cartToken);
    const plaintext = JSON.stringify([1, shopId, "c", bindingDigest, "G", "1", "en-US", future, "12345"]);
    const aad = JSON.stringify(["moda-shopify-wa-consent", 1, shopId, "c", bindingDigest]);
    const envelope = encryptCredential({ keyring, activeKeyId: "new-key", plaintext, aad });
    const value = `v1.${envelope.keyId}.${Buffer.from(envelope.nonce).toString("base64url")}.${Buffer.from(envelope.ciphertext).toString("base64url")}.${Buffer.from(envelope.authTag).toString("base64url")}`;
    expect(verify(value).status).toBe("INVALID_OR_AMBIGUOUS_RECEIPT");
  });

  it("classifies missing keyring configuration as an operational failure", () => {
    const result = verify(receipt(), { keyringJson: undefined, logger });

    expect(result).toMatchObject({
      status: "KEYRING_CONFIGURATION_FAILURE",
      reason: "KEYRING_MISSING",
    });
    expect(logger.error).toHaveBeenCalledWith(
      "shopify.consent.receipt.keyring_missing",
      expect.objectContaining({
        shopId,
        outcome: "operational_failure",
        reasonCode: "KEYRING_MISSING",
        error: expect.objectContaining({
          message: "MODA_ENCRYPTION_KEYS_JSON is not configured",
        }),
      }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs the original Shared parser failure and distinguishes invalid configuration from invalid receipts", () => {
    const result = verify(receipt(), { keyringJson: "{invalid-json", logger });
    const logged = logger.error.mock.calls.find(
      ([event]) => event === "shopify.consent.receipt.keyring_invalid",
    )?.[1] as { error?: Error } | undefined;

    expect(result).toMatchObject({
      status: "KEYRING_CONFIGURATION_FAILURE",
      reason: "KEYRING_INVALID",
    });
    expect(logged?.error).toBeInstanceOf(Error);
    expect(logged?.error?.message).toBeTruthy();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("keeps unknown receipt keys and authentication failures as terminal invalid evidence", () => {
    const keyMissing = verify(receipt(), {
      keyringJson: JSON.stringify({ "new-key": Buffer.alloc(32, 2).toString("base64") }),
      logger,
    });
    const tampered = verify(receipt().replace(/.$/, "x"), { logger });

    expect(keyMissing.status).toBe("INVALID_OR_AMBIGUOUS_RECEIPT");
    expect(tampered.status).toBe("INVALID_OR_AMBIGUOUS_RECEIPT");
    expect(logger.warn).toHaveBeenCalledWith(
      "shopify.consent.receipt.decrypt_rejected",
      expect.objectContaining({
        reasonCode: "RECEIPT_DECRYPT_REJECTED",
        error: expect.anything(),
      }),
    );
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
