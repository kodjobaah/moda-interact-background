import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import type { WooInitialFinalPermitInput } from
  "../../../src/services/woocommerce-recovery/woo-initial-send-fence.service.js";

const PHONE = "+447400123456";
export const DIGITS = "447400123456";

/** Woo writes are committed only with their immutable, matching evidence in
 * the same transaction. The disposable fixture must obey the production DB
 * trigger, not disable it or create a forged GRANTED phone in isolation.
 */
export async function recordWooDecision(
  db: PrismaClient,
  identity: { shopId: string; installationId: string; customerId: string; customerPhoneId: string },
  decision: "GRANT" | "REVOKE",
  canonicalPhone = DIGITS,
) {
  return db.$transaction(async (tx) => {
    const previous = await tx.customerPhone.findUniqueOrThrow({
      where: { id: identity.customerPhoneId },
      select: { whatsappConsentProviderObservedAt: true },
    });
    const at = new Date(Math.max(Date.now(), previous.whatsappConsentProviderObservedAt?.getTime() ?? 0) + 1000);
    const updated = await tx.customerPhone.update({
      where: { id: identity.customerPhoneId }, data: {
        phone: `+${canonicalPhone}`, whatsappCanonicalPhone: canonicalPhone,
        whatsappPhoneVerifiedAt: at, whatsappConsentPurpose: "WHATSAPP_CHECKOUT_RECOVERY",
        whatsappConsentDecision: decision === "GRANT" ? "GRANTED" : "REVOKED",
        whatsappConsentSource: "WOO_MODA_CHECKBOX",
        whatsappConsentProviderObservedAt: at,
        whatsappConsentVerifiedAt: decision === "GRANT" ? at : null,
        whatsappConsentRevision: { increment: 1 },
        whatsappConsentDecisionSequence: { increment: 1 },
      },
    });
    await tx.whatsAppConsentEvidence.create({ data: {
      shopId: identity.shopId, installationId: identity.installationId,
      customerId: identity.customerId, customerPhoneId: identity.customerPhoneId,
      eventId: randomUUID(), payloadDigest: Uint8Array.from(randomBytes(32)),
      canonicalPhone, decision, decisionAt: at,
      phoneConsentRevision: updated.whatsappConsentRevision,
      decisionSequence: updated.whatsappConsentDecisionSequence,
      ...(decision === "GRANT" ? {
        disclosureText: "I agree to receive checkout recovery messages on WhatsApp",
        disclosureVersion: "woo-test-v1", disclosureLocale: "en-GB",
      } : {}),
    } });
    return updated;
  });
}

export async function seedWooInitialPermit(db: PrismaClient): Promise<{ shopId: string; input: WooInitialFinalPermitInput }> {
  const shopId = randomUUID();
  const site = `https://${shopId}.example.test`;
  await db.shop.create({ data: {
    id: shopId, domain: site, platform: "WOOCOMMERCE", status: "ACTIVE",
    onboardingCompleted: true, defaultCountryCode: "GB",
  } });
  const installation = await db.wooCommerceInstallation.create({ data: {
    shopId, canonicalSiteUrl: site, credentialDigest: Uint8Array.from(randomBytes(32)),
  } });
  const customer = await db.customer.create({ data: { shopId, email: "customer@example.test" } });
  const phone = await db.customerPhone.create({ data: {
    customerId: customer.id, phone: PHONE,
  } });
  const granted = await recordWooDecision(db, {
    shopId, installationId: installation.id, customerId: customer.id, customerPhoneId: phone.id,
  }, "GRANT");
  const checkoutToken = `checkout-${randomUUID()}`;
  const recovery = await db.checkoutRecovery.create({ data: {
    shopId, checkoutToken, customerId: customer.id, status: "DETECTED",
    lastExternalActivityAt: new Date(Date.now() - 90_000),
  } });
  const conversation = await db.conversation.create({ data: {
    checkoutRecoveryId: recovery.id, type: "RECOVERY", controlMode: "AI",
  } });
  const attempt = await db.recoveryOutreachAttempt.create({ data: {
    checkoutRecoveryId: recovery.id, recipient: DIGITS, sequence: 1,
    trigger: "INITIAL", configuredOfferMode: "NONE", status: "PENDING",
  } });
  const message = await db.conversationMessage.create({ data: {
    conversationId: conversation.id, direction: "OUTBOUND", senderType: "AUTOMATION",
    status: "PENDING", content: "[moderated-template]",
  } });
  const idempotencyKey = `recovery-outreach:${attempt.id}`;
  // The database requires each reservation to identify its funding source.
  // Represent a real, reserved lifetime-free credit rather than bypassing
  // UsageReservation_capacity_source_shape with a source-less fixture.
  const freeCounter = await db.shopEntitlementCounter.create({ data: {
    shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS",
    grantedQuantity: 1, reservedQuantity: 1,
  } });
  await db.usageReservation.create({ data: {
    shopId, counterId: freeCounter.id,
    sourceKey: createRecoveryIdempotencyKey(shopId, idempotencyKey),
    quantity: 1, status: "RESERVED",
  } });
  await db.usageEvent.create({ data: {
    shopId, metric: "OUTBOUND_AUTOMATED_MESSAGE", quantity: 1,
    idempotencyKey, sourceType: "OUTBOUND_AUTOMATED_MESSAGE", sourceId: message.id,
  } });
  return { shopId, input: {
    shopId, recoveryId: recovery.id, checkoutToken, customerId: customer.id,
    conversationId: conversation.id, attemptId: attempt.id, messageId: message.id,
    recipient: DIGITS, idempotencyKey,
    recoveryCreditSourceKey: createRecoveryIdempotencyKey(shopId, idempotencyKey),
    templateName: "woo_recovery", languageCode: "en_GB", verifiedCategory: "MARKETING",
    expectedContent: "[moderated-template]",
    consent: { shopId, customerId: customer.id, customerPhoneId: phone.id,
      installationId: installation.id, credentialVersion: installation.credentialVersion,
      canonicalRecipient: DIGITS,
      consentRevision: granted.whatsappConsentRevision,
      consentDecisionSequence: granted.whatsappConsentDecisionSequence,
      noContactRevision: granted.whatsappNoContactRevision },
  } };
}
