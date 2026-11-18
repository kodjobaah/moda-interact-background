import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptCredential, parseCredentialKeyring } from "@modainteract/moda-interact-shared/security/credentials/node";
import type { NormalizedAbandonedCheckout } from "../../../src/domain/abandoned-checkout.js";
import type { PendingRecoveryCandidate } from "../../../src/domain/pending-recovery-candidate.js";
import type { RecoveryCheckoutSeed } from "../../../src/events/checkout-events.js";
import { ShopifyCheckoutConsentMaterializationService } from "../../../src/services/shopify-checkout-consent-materialization.service.js";

const shopId = "cm123456789012345678901234";
const keyringJson = JSON.stringify({ "old-key": Buffer.alloc(32, 9).toString("base64") });
const keyring = parseCredentialKeyring(keyringJson);
const now = new Date("2026-11-18T03:00:00.000Z");
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
    phone: "not-a-phone",
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
  customer: {
    shopifyCustomerId: checkout.customer!.shopifyCustomerId,
    phone: checkout.customer!.phone,
    email: null,
    firstName: null,
    lastName: null,
  },
  lineItems: [],
};

function signedReceipt(decision: "G" | "R" = "G") {
  const bindingDigest = createHash("sha256").update("cart-token", "utf8").digest("base64url");
  const plaintext = JSON.stringify([
    1,
    shopId,
    "c",
    bindingDigest,
    decision,
    "1",
    "en-US",
    Math.floor(now.getTime() / 1000),
    "12345",
  ]);
  const aad = JSON.stringify(["moda-shopify-wa-consent", 1, shopId, "c", bindingDigest]);
  const envelope = encryptCredential({
    keyring,
    activeKeyId: "old-key",
    plaintext,
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

function createService(result: any = { status: "MATERIALISED_GRANTED" }) {
  const consent = { materializeExplicitChoice: vi.fn(async () => result) };
  const prepareCustomer = vi.fn(async () => ({ id: "customer-db-id" }));
  const service = new ShopifyCheckoutConsentMaterializationService(
    consent as never,
    prepareCustomer,
    () => keyringJson,
    () => now,
  );
  return { service, consent, prepareCustomer };
}

beforeEach(() => vi.clearAllMocks());

describe("Shopify checkout consent materialisation", () => {
  it("does not create a decision for a missing attribute", async () => {
    const harness = createService();
    await expect(harness.service.materialize({ candidate, checkout, seed }))
      .resolves.toEqual({ status: "NO_EXPLICIT_CHOICE" });
    expect(harness.prepareCustomer).not.toHaveBeenCalled();
    expect(harness.consent.materializeExplicitChoice).not.toHaveBeenCalled();
  });

  it("verifies and materialises a grant using the valid billing fallback after an invalid customer phone", async () => {
    const harness = createService();
    const result = await harness.service.materialize({
      candidate,
      checkout: { ...checkout, consentReceiptAttribute: { kind: "VALUE", value: signedReceipt() } },
      seed,
    });

    expect(result).toEqual({ status: "MATERIALISED_GRANTED", recipient: "14155550123" });
    expect(harness.prepareCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ customer: expect.objectContaining({ phone: "+14155550123" }) }),
      shopId,
    );
    expect(harness.consent.materializeExplicitChoice).toHaveBeenCalledWith({
      shopId,
      shopifyCustomerId: "gid://shopify/Customer/12345",
      recipient: "+14155550123",
      decision: "GRANTED",
    });
  });

  it("defers when the authenticated candidate token is missing", async () => {
    const harness = createService();
    await expect(harness.service.materialize({
      candidate: { ...candidate, cartToken: null },
      checkout: { ...checkout, consentReceiptAttribute: { kind: "VALUE", value: signedReceipt() } },
      seed,
    })).resolves.toEqual({ status: "DEFER_CHECKOUT_BINDING" });
    expect(harness.prepareCustomer).not.toHaveBeenCalled();
    expect(harness.consent.materializeExplicitChoice).not.toHaveBeenCalled();
  });

  it("does not infer a customer principal from a guest receipt and phone", async () => {
    const guestClaims = JSON.stringify([
      1, shopId, "c",
      createHash("sha256").update("cart-token", "utf8").digest("base64url"),
      "R", "1", "en-US", Math.floor(now.getTime() / 1000), "-",
    ]);
    const bindingDigest = createHash("sha256").update("cart-token", "utf8").digest("base64url");
    const envelope = encryptCredential({
      keyring,
      activeKeyId: "old-key",
      plaintext: guestClaims,
      aad: JSON.stringify(["moda-shopify-wa-consent", 1, shopId, "c", bindingDigest]),
    });
    const guestReceipt = `v1.${envelope.keyId}.${Buffer.from(envelope.nonce).toString("base64url")}.${Buffer.from(envelope.ciphertext).toString("base64url")}.${Buffer.from(envelope.authTag).toString("base64url")}`;
    const harness = createService({ status: "MATERIALISED_REVOKED" });

    await expect(harness.service.materialize({
      candidate,
      checkout: {
        ...checkout,
        customer: null,
        consentReceiptAttribute: { kind: "VALUE", value: guestReceipt },
      },
      seed: { ...seed, customer: { ...seed.customer, shopifyCustomerId: null } },
    })).resolves.toEqual({ status: "DEFER_IDENTITY_OR_RECIPIENT" });
    expect(harness.consent.materializeExplicitChoice).not.toHaveBeenCalled();
  });

  it("reports failed SQL materialisation instead of claiming success", async () => {
    const harness = createService({ status: "MATERIALISATION_FAILURE", reason: "CONSENT_WRITE_FAILURE" });
    await expect(harness.service.materialize({
      candidate,
      checkout: { ...checkout, consentReceiptAttribute: { kind: "VALUE", value: signedReceipt("R") } },
      seed,
    })).resolves.toEqual({ status: "MATERIALISATION_FAILURE", reason: "CONSENT_WRITE_FAILURE" });
  });
});
