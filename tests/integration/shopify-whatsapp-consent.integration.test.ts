import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { encryptCredential, parseCredentialKeyring } from "@modainteract/moda-interact-shared/security/credentials/node";
import type { NormalizedAbandonedCheckout } from "../../src/domain/abandoned-checkout.js";
import type { PendingRecoveryCandidate } from "../../src/domain/pending-recovery-candidate.js";
import type { RecoveryCheckoutSeed } from "../../src/events/checkout-events.js";
import { RecoveryMaterializationService } from "../../src/services/checkout-recovery/recovery-materialization.service.js";
import { RecoveryStoredConsentService } from "../../src/services/recovery-conversation/recovery-stored-consent.service.js";
import { ShopifyCheckoutConsentMaterializationService } from "../../src/services/shopify-checkout-consent-materialization.service.js";
import { ShopifyWhatsAppConsentService } from "../../src/services/shopify-whatsapp-consent.service.js";

const url = process.env.TEST_DATABASE_URL;
const describeWithDatabase = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

describeWithDatabase("ARCH-077 signed checkout consent SQL materialisation", () => {
  it("gates materialisation on completed-checkout state, applies recoverable revoke before outreach, and records the accepted late-A replay risk", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const suffix = randomUUID().replaceAll("-", "");
    const shopId = `c${suffix.slice(0, 24)}`;
    const domain = `${shopId}.myshopify.com`;
    const phoneNumber = "+447400123456";
    const shopifyCustomerId = "125678912345";
    const keyringJson = JSON.stringify({ "consent-test-key": Buffer.alloc(32, 7).toString("base64") });
    const keyring = parseCredentialKeyring(keyringJson);
    let timestamp = Date.now();
    const consent = new ShopifyWhatsAppConsentService(db, () => {
      timestamp += 1000;
      return new Date(timestamp);
    });
    const materializer = new ShopifyCheckoutConsentMaterializationService(
      consent,
      undefined,
      () => keyringJson,
      () => new Date(timestamp),
    );
    const cartTokenA = `cart-a-${suffix}`;
    const cartTokenB = `cart-b-${suffix}`;
    const checkoutTokenA = `checkout-a-${suffix}`;
    const checkoutTokenB = `checkout-b-${suffix}`;
    const checkoutUrlA = `https://${domain}/checkouts/${suffix}/a`;
    const checkoutUrlB = `https://${domain}/checkouts/${suffix}/b`;
    const customerGid = `gid://shopify/Customer/${shopifyCustomerId}`;

    const signedReceipt = (cartToken: string, decision: "G" | "R") => {
      const bindingDigest = createHash("sha256")
        .update(cartToken, "utf8")
        .digest("base64url");
      const plaintext = JSON.stringify([
        1, shopId, "c", bindingDigest, decision, "1", "en-GB",
        Math.floor(timestamp / 1000), shopifyCustomerId,
      ]);
      const aad = JSON.stringify([
        "moda-shopify-wa-consent", 1, shopId, "c", bindingDigest,
      ]);
      const envelope = encryptCredential({
        keyring,
        activeKeyId: "consent-test-key",
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
    };

    const candidateFor = (
      checkoutToken: string,
      cartToken: string,
      checkoutUrl: string,
    ): PendingRecoveryCandidate => ({
      shopId, shopDomain: domain, checkoutToken, cartToken: `${cartToken}?key=opaque`,
      abandonedCheckoutUrl: checkoutUrl, checkoutCreatedAt: new Date(timestamp).toISOString(),
    });
    const seedFor = (candidate: PendingRecoveryCandidate): RecoveryCheckoutSeed => ({
      shop: domain, checkoutToken: candidate.checkoutToken, cartToken: candidate.cartToken,
      detectedAt: new Date(timestamp).toISOString(), currency: "GBP", totalPrice: "25.00",
      checkoutUrl: candidate.abandonedCheckoutUrl, completedAt: null,
      customer: {
        shopifyCustomerId: customerGid, phone: phoneNumber, email: null,
        firstName: "Taylor", lastName: null,
      },
      lineItems: [],
    });
    const checkoutFor = (
      candidate: PendingRecoveryCandidate,
      decision: "G" | "R",
      completedAt: string | null = null,
    ): NormalizedAbandonedCheckout => ({
      shopifyAbandonedCheckoutId: `gid://shopify/AbandonedCheckout/${candidate.checkoutToken}`,
      abandonedCheckoutUrl: candidate.abandonedCheckoutUrl!,
      createdAt: candidate.checkoutCreatedAt!,
      completedAt,
      shopifyPlus: false,
      consentReceiptAttribute: { kind: "VALUE", value: signedReceipt(cartTokenFor(candidate), decision) },
      billingPhone: null,
      shippingPhone: null,
      currencyCode: "GBP",
      totalPrice: "25.00",
      internationalContext: {
        languageTag: "en-GB", languageSource: null, countryCode: "GB",
        currencyCode: "GBP", timeZone: null,
      },
      customer: {
        shopifyCustomerId: customerGid, email: null, phone: phoneNumber,
        firstName: "Taylor", lastName: null,
      },
      lineItems: [],
    });
    const cartTokenFor = (candidate: PendingRecoveryCandidate) =>
      candidate.checkoutToken === checkoutTokenA ? cartTokenA : cartTokenB;

    try {
      await db.shop.create({
        data: {
          id: shopId, domain, platform: "SHOPIFY", status: "ACTIVE",
          defaultCountryCode: "GB",
        },
      });
      const customer = await db.customer.create({
        data: { shopId, shopifyCustomerId },
      });
      const phone = await db.customerPhone.create({
        data: { customerId: customer.id, phone: phoneNumber },
      });

      const checkoutByToken = new Map<string, NormalizedAbandonedCheckout>();
      const attempts: string[] = [];
      let crashAfterFirstConsentCommit = true;
      const recovery = new RecoveryMaterializationService({
        executionEligibility: { evaluate: async () => ({ allowed: true, shopId }) } as never,
        abandonedCheckoutLookup: {
          resolveShopDomain: async () => domain,
          lookup: async (input) => ({
            kind: "found" as const,
            checkout: checkoutByToken.get(input.checkoutToken)!,
          }),
        } as never,
        pendingRecoveryCandidate: {
          withCheckoutLock: async (_shop: string, _token: string, callback: () => Promise<unknown>) =>
            callback(),
          hasOrderProcessed: async () => false,
          findCandidateJobIdByCheckout: async () => null,
        } as never,
        findLatestRecovery: async (targetShopId, checkoutToken) =>
          db.checkoutRecovery.findFirst({
            where: { shopId: targetShopId, checkoutToken },
            orderBy: { generation: "desc" },
          }) as never,
        snapshotBuilder: {
          build: async (candidate: PendingRecoveryCandidate) => seedFor(candidate),
        } as never,
        recipientResolver: { resolve: async () => phoneNumber.slice(1) } as never,
        consentReceipt: materializer,
        initiate: async (seed, generation) => {
          attempts.push(seed.checkoutToken);
          if (seed.checkoutToken === checkoutTokenA && crashAfterFirstConsentCommit) {
            crashAfterFirstConsentCommit = false;
            throw new Error("simulated worker crash after consent commit");
          }
          return db.checkoutRecovery.create({
            data: {
              shopId, customerId: customer.id, checkoutToken: seed.checkoutToken,
              cartToken: seed.cartToken, generation, status: "DETECTED",
              lastExternalActivityAt: new Date(seed.detectedAt),
            },
          });
        },
      });

      const candidateA = candidateFor(checkoutTokenA, cartTokenA, checkoutUrlA);
      checkoutByToken.set(checkoutTokenA, checkoutFor(candidateA, "G"));
      await expect(recovery.materialize(candidateA))
        .rejects.toThrow("simulated worker crash after consent commit");
      const afterInterruptedGrant = await db.customerPhone.findUniqueOrThrow({ where: { id: phone.id } });
      expect(afterInterruptedGrant).toMatchObject({
        whatsappConsentDecision: "GRANTED",
        whatsappConsentRevision: 1n,
      });
      expect(await db.checkoutRecovery.count({ where: { shopId, checkoutToken: checkoutTokenA } })).toBe(0);

      // The retry has no per-checkout SQL evidence proving the prior write. It
      // re-verifies and runs the normal transaction; the revision increment is
      // intentionally not misreported as a proven no-op.
      await expect(recovery.materialize(candidateA)).resolves.toMatchObject({
        outcome: "recovery-created", checkoutToken: checkoutTokenA,
      });
      expect(await db.customerPhone.findUniqueOrThrow({ where: { id: phone.id } }))
        .toMatchObject({ whatsappConsentDecision: "GRANTED", whatsappConsentRevision: 2n });
      expect(attempts).toEqual([checkoutTokenA, checkoutTokenA]);

      const candidateBPaid = candidateFor(checkoutTokenB, cartTokenB, checkoutUrlB);
      checkoutByToken.set(checkoutTokenB, checkoutFor(candidateBPaid, "R", new Date().toISOString()));
      const beforePaid = await db.customerPhone.findUniqueOrThrow({ where: { id: phone.id } });
      await expect(recovery.materialize(candidateBPaid)).resolves.toMatchObject({
        outcome: "discarded-not-recoverable", checkoutToken: checkoutTokenB,
      });
      expect(await db.customerPhone.findUniqueOrThrow({ where: { id: phone.id } }))
        .toMatchObject({
          whatsappConsentDecision: beforePaid.whatsappConsentDecision,
          whatsappConsentRevision: beforePaid.whatsappConsentRevision,
        });
      expect(await db.checkoutRecovery.count({ where: { shopId, checkoutToken: checkoutTokenB } })).toBe(0);

      checkoutByToken.set(checkoutTokenB, checkoutFor(candidateBPaid, "R"));
      await expect(recovery.materialize(candidateBPaid)).resolves.toMatchObject({
        outcome: "discarded-consent-revoked", checkoutToken: checkoutTokenB,
      });
      const afterRevoke = await db.customerPhone.findUniqueOrThrow({ where: { id: phone.id } });
      expect(afterRevoke).toMatchObject({
        whatsappConsentDecision: "REVOKED",
        whatsappConsentRevision: 3n,
        whatsappConsentDecisionSequence: 3n,
      });
      expect(await db.checkoutRecovery.count({ where: { shopId, checkoutToken: checkoutTokenB } })).toBe(0);
      const storedConsent = new RecoveryStoredConsentService(db, consent);
      const recoveryA = await db.checkoutRecovery.findFirstOrThrow({
        where: { shopId, checkoutToken: checkoutTokenA },
      });
      await expect(storedConsent.preflight({
        shopId, recoveryId: recoveryA.id, recipient: phoneNumber,
      })).resolves.toMatchObject({ kind: "denied", reason: "stored-consent-denied" });

      // The architect-approved stateless contract deliberately accepts a
      // late A decision replay because no current-schema record identifies its
      // receipt. This test documents the risk instead of asserting ordering.
      await expect(materializer.materialize({
        candidate: candidateA,
        checkout: checkoutFor(candidateA, "G"),
        seed: seedFor(candidateA),
      })).resolves.toMatchObject({ status: "MATERIALISED_GRANTED" });
      expect(await db.customerPhone.findUniqueOrThrow({ where: { id: phone.id } }))
        .toMatchObject({ whatsappConsentDecision: "GRANTED", whatsappConsentRevision: 4n });
    } finally {
      await db.shop.deleteMany({ where: { id: shopId } });
      await db.$disconnect();
    }
  });

  it("applies sequential Cart A grant and Cart B revoke under current CustomerPhone SQL constraints", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const suffix = randomUUID().replaceAll("-", "");
    const shopId = `arch077-consent-${suffix}`;
    let timestamp = Date.parse("2026-11-18T03:00:00.000Z");
    const consent = new ShopifyWhatsAppConsentService(db, () => {
      timestamp += 1000;
      return new Date(timestamp);
    });
    try {
      await db.shop.create({
        data: {
          id: shopId,
          domain: `${shopId}.myshopify.com`,
          platform: "SHOPIFY",
          defaultCountryCode: "GB",
        },
      });
      const customer = await db.customer.create({
        data: { shopId, shopifyCustomerId: "125678912345" },
      });
      const phone = await db.customerPhone.create({
        data: { customerId: customer.id, phone: "+447400123456" },
      });
      const recipient = {
        shopId,
        customerId: customer.id,
        shopifyCustomerId: "gid://shopify/Customer/125678912345",
        recipient: "+447400123456",
      };

      await expect(consent.materializeExplicitChoice({
        ...recipient,
        decision: "GRANTED",
      })).resolves.toEqual({ status: "MATERIALISED_GRANTED" });
      await expect(consent.evaluateStoredRecipient({
        shopId,
        customerId: customer.id,
        recipient: recipient.recipient,
      })).resolves.toMatchObject({ status: "ALLOWED", customerPhoneId: phone.id });

      // Cart B's recoverable revoke is committed before the caller declines
      // recovery admission. The current schema intentionally has no durable
      // per-checkout receipt checkpoint, so an exceptional late Cart A write
      // remains an accepted residual risk rather than an absolute invariant.
      await expect(consent.materializeExplicitChoice({
        ...recipient,
        decision: "REVOKED",
      })).resolves.toEqual({ status: "MATERIALISED_REVOKED" });
      const afterRevoke = await db.customerPhone.findUniqueOrThrow({ where: { id: phone.id } });
      expect(afterRevoke).toMatchObject({
        whatsappConsentDecision: "REVOKED",
        whatsappConsentSource: "SHOPIFY_NATIVE",
        whatsappConsentRevision: 2n,
        whatsappConsentDecisionSequence: 2n,
      });
      await expect(consent.evaluateStoredRecipient({
        shopId,
        customerId: customer.id,
        recipient: recipient.recipient,
      })).resolves.toEqual({ status: "NOT_AUTHORISED", reason: "NATIVE_CONSENT_NOT_GRANTED" });

      await db.customerPhone.update({
        where: { id: phone.id },
        data: {
          whatsappNoContact: true,
          whatsappNoContactReason: "CUSTOMER_STOP",
          whatsappNoContactAt: new Date("2026-11-18T03:10:00.000Z"),
          whatsappNoContactRevision: { increment: 1 },
        },
      });
      await expect(consent.materializeExplicitChoice({
        ...recipient,
        decision: "GRANTED",
      })).resolves.toEqual({ status: "BLOCKED_STOP" });
      await expect(consent.materializeExplicitChoice({
        ...recipient,
        decision: "REVOKED",
      })).resolves.toEqual({ status: "MATERIALISED_REVOKED" });
      const afterStop = await db.customerPhone.findUniqueOrThrow({ where: { id: phone.id } });
      expect(afterStop).toMatchObject({
        whatsappConsentDecision: "REVOKED",
        whatsappNoContact: true,
        whatsappNoContactReason: "CUSTOMER_STOP",
        whatsappNoContactRevision: 1n,
      });
    } finally {
      await db.shop.deleteMany({ where: { id: shopId } });
      await db.$disconnect();
    }
  });
});
