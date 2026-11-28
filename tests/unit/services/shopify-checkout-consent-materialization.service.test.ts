import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  encryptCredential,
  parseCredentialKeyring,
} from "@modainteract/moda-interact-shared/security/credentials/node";
import type { NormalizedAbandonedCheckout } from "../../../src/domain/abandoned-checkout.js";
import type { PendingRecoveryCandidate } from "../../../src/domain/pending-recovery-candidate.js";
import type { RecoveryCheckoutSeed } from "../../../src/events/checkout-events.js";
import { ShopifyCheckoutConsentMaterializationService } from "../../../src/services/shopify-checkout-consent-materialization.service.js";
import { materializeShopifyCheckoutPhones } from "../../../src/services/shopify-whatsapp-consent/phone-resolution.js";

vi.mock(
  "../../../src/services/shopify-whatsapp-consent/phone-resolution.js",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../../../src/services/shopify-whatsapp-consent/phone-resolution.js")
      >();
    return { ...original, materializeShopifyCheckoutPhones: vi.fn() };
  },
);
const materializePhones = vi.mocked(materializeShopifyCheckoutPhones);
const shopId = "cm123456789012345678901234";
const now = new Date("2026-11-18T03:00:00.000Z");
const keyringJson = JSON.stringify({
  "old-key": Buffer.alloc(32, 9).toString("base64"),
});
const keyring = parseCredentialKeyring(keyringJson);
const candidate: PendingRecoveryCandidate = {
  shopId,
  shopDomain: "merchant.myshopify.com",
  checkoutToken: "checkout-token",
  cartToken: "cart-token?key=secret",
  abandonedCheckoutUrl: "https://merchant.myshopify.com/recover",
  checkoutCreatedAt: now.toISOString(),
};
const checkout: NormalizedAbandonedCheckout = {
  shopifyAbandonedCheckoutId: "gid://shopify/AbandonedCheckout/1",
  abandonedCheckoutUrl: candidate.abandonedCheckoutUrl!,
  createdAt: now.toISOString(),
  completedAt: null,
  shopifyPlus: false,
  consentReceiptAttribute: { kind: "MISSING" },
  billingPhone: "+14155550123",
  shippingPhone: "+14155550999",
  billingCountryCode: "US",
  shippingCountryCode: "US",
  currencyCode: "USD",
  totalPrice: "12.00",
  internationalContext: {
    languageTag: "en-US",
    languageSource: null,
    countryCode: "US",
    currencyCode: "USD",
    timeZone: null,
  },
  customer: {
    shopifyCustomerId: "gid://shopify/Customer/12345",
    email: null,
    phone: "+14155550001",
    firstName: null,
    lastName: null,
  },
  lineItems: [],
};
const seed: RecoveryCheckoutSeed = {
  shop: candidate.shopDomain,
  checkoutToken: candidate.checkoutToken,
  cartToken: candidate.cartToken,
  detectedAt: now.toISOString(),
  currency: "USD",
  totalPrice: "12.00",
  checkoutUrl: candidate.abandonedCheckoutUrl,
  completedAt: null,
  customer: { ...checkout.customer! },
  lineItems: [],
};

function receipt(decision: "G" | "R", claimCustomerId: string = "12345") {
  const digest = createHash("sha256")
    .update("cart-token", "utf8")
    .digest("base64url");
  const claims = [
    1,
    shopId,
    "c",
    digest,
    decision,
    "1",
    "en-US",
    Math.floor(now.getTime() / 1000),
    claimCustomerId,
  ];
  const envelope = encryptCredential({
    keyring,
    activeKeyId: "old-key",
    plaintext: JSON.stringify(claims),
    aad: JSON.stringify(["moda-shopify-wa-consent", 1, shopId, "c", digest]),
  });
  return [
    "v1",
    envelope.keyId,
    Buffer.from(envelope.nonce).toString("base64url"),
    Buffer.from(envelope.ciphertext).toString("base64url"),
    Buffer.from(envelope.authTag).toString("base64url"),
  ].join(".");
}
function service(keyring: () => string | undefined = () => keyringJson) {
  return new ShopifyCheckoutConsentMaterializationService(keyring, () => now);
}

beforeEach(() => vi.clearAllMocks());

describe("Shopify multi-phone checkout consent materialisation", () => {
  it("does not invent a decision when no explicit receipt exists", async () => {
    await expect(
      service().materialize({ candidate, checkout, seed }),
    ).resolves.toEqual({ status: "NO_EXPLICIT_CHOICE" });
    expect(materializePhones).not.toHaveBeenCalled();
  });

  it("materialises all checkout phones and returns one selected recipient", async () => {
    materializePhones.mockResolvedValueOnce({
      customerId: "guest-moda-id",
      selected: {
        customerId: "guest-moda-id",
        customerPhoneId: "customer-phone-id",
        recipient: "14155550001",
        source: "customer",
      },
      consentWriteCount: 3,
      evidenceInsertedCount: 3,
      validPhoneCount: 3,
      invalidSources: [],
    });
    await expect(
      service().materialize({
        candidate,
        checkout: {
          ...checkout,
          consentReceiptAttribute: { kind: "VALUE", value: receipt("G") },
        },
        seed,
      }),
    ).resolves.toEqual({
      status: "MATERIALISED_GRANTED",
      recipient: "14155550001",
      customerId: "guest-moda-id",
    });
    expect(materializePhones).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId,
        decision: "GRANTED",
        acceptedAt: Math.floor(now.getTime() / 1000),
        locale: "en-US",
        checkoutToken: candidate.checkoutToken,
      }),
    );
  });

  it("accepts a checkout-bound guest receipt when Shopify later returns a customer ID", async () => {
    materializePhones.mockResolvedValueOnce({
      customerId: "local-guest",
      selected: null,
      consentWriteCount: 3,
      evidenceInsertedCount: 3,
      validPhoneCount: 3,
      invalidSources: [],
    });
    await expect(
      service().materialize({
        candidate,
        checkout: {
          ...checkout,
          consentReceiptAttribute: { kind: "VALUE", value: receipt("R", "-") },
        },
        seed,
      }),
    ).resolves.toEqual({ status: "MATERIALISED_REVOKED" });
    expect(materializePhones).toHaveBeenCalledOnce();
  });

  it("does not apply an invalid binding or incorrect signed account claim", async () => {
    for (const [cartToken, value] of [
      [null, receipt("G")],
      [candidate.cartToken, receipt("G", "67890")],
    ] as const) {
      const result = await service().materialize({
        candidate: { ...candidate, cartToken },
        checkout: {
          ...checkout,
          consentReceiptAttribute: { kind: "VALUE", value },
        },
        seed,
      });
      expect(result.status).not.toBe("MATERIALISED_GRANTED");
    }
    expect(materializePhones).not.toHaveBeenCalled();
  });

  it("fails closed and preserves original keyring errors", async () => {
    const result = await service(() => undefined).materialize({
      candidate,
      checkout: {
        ...checkout,
        consentReceiptAttribute: { kind: "VALUE", value: receipt("G") },
      },
      seed,
    });
    expect(result).toMatchObject({
      status: "MATERIALISATION_FAILURE",
      reason: "KEYRING_MISSING",
    });
    expect(materializePhones).not.toHaveBeenCalled();
  });
});
