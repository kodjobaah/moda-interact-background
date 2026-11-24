import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { encryptCredential, parseCredentialKeyring } from "@modainteract/moda-interact-shared/security/credentials/node";
import type { NormalizedAbandonedCheckout } from "../../src/domain/abandoned-checkout.js";
import type { PendingRecoveryCandidate } from "../../src/domain/pending-recovery-candidate.js";
import type { RecoveryCheckoutSeed } from "../../src/events/checkout-events.js";
import { ShopifyCheckoutConsentMaterializationService } from "../../src/services/shopify-checkout-consent-materialization.service.js";
import { ShopifyWhatsAppConsentService } from "../../src/services/shopify-whatsapp-consent.service.js";

const url = process.env.TEST_DATABASE_URL;
const describeWithDatabase = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

/** The runner owns this disposable PostgreSQL database and its cleanup. */
describeWithDatabase("Shopify guest multi-phone checkout consent with immutable evidence", () => {
  it("persists three distinct phones and grants, replays idempotently, preserves phone-specific STOP and selects an older grant after a revoke", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const shopId = `c${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const domain = `${shopId}.myshopify.com`;
    const guestNumbers = ["+447400123456", "+447400654321", "+447400987654"];
    const previouslyGranted = "+447400555888";
    const shopifyCustomerId = "gid://shopify/Customer/125678912345";
    const secret = JSON.stringify({ "consent-test-key": Buffer.alloc(32, 7).toString("base64") });
    const keyring = parseCredentialKeyring(secret);
    const firstAt = new Date("2026-11-24T10:00:00.000Z");

    function signedReceipt(cart: string, decision: "G" | "R", at: Date, customerId = "-") {
      const digest = createHash("sha256").update(cart, "utf8").digest("base64url");
      const claims = [1, shopId, "c", digest, decision, "1", "en-GB",
        Math.floor(at.getTime() / 1000), customerId];
      const aad = JSON.stringify(["moda-shopify-wa-consent", 1, shopId, "c", digest]);
      const envelope = encryptCredential({ keyring, activeKeyId: "consent-test-key",
        plaintext: JSON.stringify(claims), aad });
      return ["v1", envelope.keyId, Buffer.from(envelope.nonce).toString("base64url"),
        Buffer.from(envelope.ciphertext).toString("base64url"),
        Buffer.from(envelope.authTag).toString("base64url")].join(".");
    }

    function fixture(input: {
      cart: string; decision: "G" | "R"; at: Date;
      numbers: Array<string | null>; account?: string | null;
    }) {
      const candidate: PendingRecoveryCandidate = {
        shopId, shopDomain: domain, checkoutToken: `${input.cart}-checkout`,
        cartToken: `${input.cart}?key=opaque`,
        abandonedCheckoutUrl: `https://${domain}/checkouts/${input.cart}/recover`,
        checkoutCreatedAt: input.at.toISOString(),
      };
      const customer = { shopifyCustomerId: input.account ?? null, phone: input.numbers[0] ?? null,
        email: null, firstName: "Alex", lastName: null };
      const checkout: NormalizedAbandonedCheckout = {
        shopifyAbandonedCheckoutId: `gid://shopify/AbandonedCheckout/${input.cart}`,
        abandonedCheckoutUrl: candidate.abandonedCheckoutUrl!,
        createdAt: input.at.toISOString(), completedAt: null,
        shopifyPlus: false,
        consentReceiptAttribute: { kind: "VALUE", value: signedReceipt(input.cart, input.decision, input.at) },
        billingPhone: input.numbers[1] ?? null, shippingPhone: input.numbers[2] ?? null,
        billingCountryCode: "GB", shippingCountryCode: "GB",
        currencyCode: "GBP", totalPrice: "50.00",
        internationalContext: { languageTag: "en-GB", languageSource: null,
          countryCode: "GB", currencyCode: "GBP", timeZone: null },
        customer, lineItems: [],
      };
      const seed: RecoveryCheckoutSeed = {
        shop: domain, checkoutToken: candidate.checkoutToken, cartToken: candidate.cartToken,
        detectedAt: input.at.toISOString(), currency: "GBP", totalPrice: "50.00",
        checkoutUrl: candidate.abandonedCheckoutUrl, completedAt: null,
        customer, lineItems: [],
      };
      return { candidate, checkout, seed };
    }

    function materializer(at: Date) {
      return new ShopifyCheckoutConsentMaterializationService(() => secret, () => at, undefined, db);
    }

    try {
      await db.shop.create({ data: { id: shopId, domain, platform: "SHOPIFY",
        status: "ACTIVE", defaultCountryCode: "GB" } });
      const first = fixture({ cart: "cart-a", decision: "G", at: firstAt, numbers: guestNumbers });
      const granted = await materializer(firstAt).materialize(first);
      expect(granted).toMatchObject({ status: "MATERIALISED_GRANTED", recipient: "447400123456" });
      if (granted.status !== "MATERIALISED_GRANTED") throw new Error("Expected signed grant");
      const modaCustomerId = granted.customerId;
      expect((await db.customer.findUniqueOrThrow({ where: { id: modaCustomerId } })).shopifyCustomerId).toBeNull();
      const phones = await db.customerPhone.findMany({ where: { customerId: modaCustomerId, endedAt: null } });
      expect(phones).toHaveLength(3);
      expect(phones.every(p => p.whatsappConsentDecision === "GRANTED")).toBe(true);
      expect(await db.whatsAppConsentEvidence.count({ where: { shopId } })).toBe(3);
      await expect(materializer(firstAt).materialize(first))
        .resolves.toMatchObject({ status: "MATERIALISED_GRANTED", recipient: "447400123456" });
      expect(await db.whatsAppConsentEvidence.count({ where: { shopId } })).toBe(3);
      expect((await db.customerPhone.findMany({ where: { customerId: modaCustomerId } }))
        .every(p => p.whatsappConsentRevision === 1n)).toBe(true);

      // Shopify may link a previously guest checkout to an account later.
      const accountCheckout = { ...first, checkout: { ...first.checkout,
        customer: { ...first.checkout.customer!, shopifyCustomerId },
      } };
      await materializer(firstAt).materialize(accountCheckout);
      expect((await db.customer.findUniqueOrThrow({ where: { id: modaCustomerId } }))
        .shopifyCustomerId).toBe("125678912345");

      // A quoted STOP on the customer phone suppresses that exact number only.
      const stopped = phones.find(p => p.whatsappCanonicalPhone === "447400123456")!;
      await db.customerPhone.update({ where: { id: stopped.id }, data: {
        whatsappNoContact: true, whatsappNoContactReason: "CUSTOMER_STOP",
        whatsappNoContactAt: new Date(firstAt.getTime() + 500),
        whatsappNoContactRevision: { increment: 1 },
      } });
      const consent = new ShopifyWhatsAppConsentService(db);
      await expect(consent.evaluateStoredRecipient({ shopId, customerId: modaCustomerId,
        recipient: guestNumbers[0]! }))
        .resolves.toEqual({ status: "NOT_AUTHORISED", reason: "LOCAL_NO_CONTACT" });
      await expect(consent.evaluateStoredRecipient({ shopId, customerId: modaCustomerId,
        recipient: guestNumbers[1]! }))
        .resolves.toMatchObject({ status: "ALLOWED" });

      // A separate checkout adds a fourth number without closing other phones.
      const secondAt = new Date(firstAt.getTime() + 2000);
      const second = fixture({ cart: "cart-b", decision: "G", at: secondAt,
        numbers: [previouslyGranted, null, null], account: shopifyCustomerId });
      await expect(materializer(secondAt).materialize(second))
        .resolves.toMatchObject({ status: "MATERIALISED_GRANTED", recipient: "447400555888" });
      expect(await db.customerPhone.count({ where: { customerId: modaCustomerId, endedAt: null } })).toBe(4);

      // Revoke only the three numbers present on cart C. The fourth grant survives.
      const thirdAt = new Date(firstAt.getTime() + 4000);
      const third = fixture({ cart: "cart-c", decision: "R", at: thirdAt,
        numbers: guestNumbers, account: shopifyCustomerId });
      await expect(materializer(thirdAt).materialize(third))
        .resolves.toMatchObject({ status: "MATERIALISED_GRANTED", recipient: "447400555888" });
      const afterRevoke = await db.customerPhone.findMany({ where: { customerId: modaCustomerId, endedAt: null } });
      expect(afterRevoke.filter(p => p.whatsappConsentDecision === "REVOKED")).toHaveLength(3);
      expect(afterRevoke.find(p => p.id === stopped.id)).toMatchObject({
        whatsappNoContact: true, whatsappNoContactReason: "CUSTOMER_STOP" });
      expect(afterRevoke.find(p => p.whatsappCanonicalPhone === "447400555888")?.whatsappConsentDecision)
        .toBe("GRANTED");
      expect(await db.whatsAppConsentEvidence.count({ where: { shopId } })).toBe(7);
      await materializer(thirdAt).materialize(third);
      expect(await db.whatsAppConsentEvidence.count({ where: { shopId } })).toBe(7);
    } finally {
      // This suite runs only against an isolated, disposable database. Its
      // append-only evidence is intentionally not deleted or backfilled.
      await db.$disconnect();
    }
  });
});
