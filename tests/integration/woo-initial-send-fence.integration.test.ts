import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { afterAll, describe, expect, it } from "vitest";
import { WooInitialSendFenceService, type WooInitialFinalPermitInput } from
  "../../src/services/woocommerce-recovery/woo-initial-send-fence.service.js";
import { writeLocalStop } from "../../src/services/whatsapp-contact-opt-out/stop-writer.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const withDatabase = databaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;
const PHONE = "+447400123456";
const DIGITS = "447400123456";

/** Woo writes are committed only with their immutable, matching evidence in
 * the same transaction. The disposable fixture must obey the production DB
 * trigger, not disable it or create a forged GRANTED phone in isolation.
 */
async function recordWooDecision(
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

async function setup(db: PrismaClient): Promise<{ shopId: string; input: WooInitialFinalPermitInput }> {
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

withDatabase("ARCH-046 Woo initial permit: real PostgreSQL", () => {
  const clients: PrismaClient[] = [];
  const client = () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    clients.push(db);
    return db;
  };
  // Woo consent evidence is immutable and referenced by RESTRICT foreign keys.
  // Tests run only on the disposable integration database; don't mutate or
  // delete immutable consent history to clean up individual cases.
  afterAll(async () => {
    await Promise.all(clients.map((db) => db.$disconnect()));
  });
  const seed = (db: PrismaClient) => setup(db);

  it("two independent SQL clients admit only one provider dispatch, with no provider network call", async () => {
    const a = client(); const b = client();
    const { input } = await seed(a);
    const results = await Promise.all([
      new WooInitialSendFenceService(a).admitFinalSend(input),
      new WooInitialSendFenceService(b).admitFinalSend(input),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(["admitted", "suppressed"]);
    const message = await a.conversationMessage.findUniqueOrThrow({ where: { id: input.messageId } });
    expect(message.providerDispatchKey).toMatch(/^arch046-woo-initial-[0-9a-f]{64}$/);
    expect(message.providerDispatchAdmittedAt).toBeTruthy();
    expect(message.status).toBe("PENDING"); // no fake provider confirmation
    expect(await a.usageEvent.count({ where: { idempotencyKey: input.idempotencyKey } })).toBe(1);
  }, 45_000);

  it("a previously committed STOP blocks the permit, including a later local grant", async () => {
    const db = client();
    const { input, shopId } = await seed(db);
    await writeLocalStop(db, { canonical: DIGITS, shopId, eventId: randomUUID(), at: new Date() });
    const stopped = await new WooInitialSendFenceService(db).admitFinalSend(input);
    expect(stopped.kind).toBe("suppressed");
    const granted = await recordWooDecision(db, {
      shopId, installationId: input.consent.installationId,
      customerId: input.customerId, customerPhoneId: input.consent.customerPhoneId,
    }, "GRANT");
    // A fresh legitimate Woo GRANT must not override the authoritative STOP.
    expect((await new WooInitialSendFenceService(db).admitFinalSend({
      ...input, consent: { ...input.consent,
        consentRevision: granted.whatsappConsentRevision,
        consentDecisionSequence: granted.whatsappConsentDecisionSequence,
        noContactRevision: granted.whatsappNoContactRevision },
    })).kind).toBe("suppressed");
    const message = await db.conversationMessage.findUniqueOrThrow({ where: { id: input.messageId } });
    expect(message.providerDispatchKey).toBeNull();
  }, 45_000);

  it("an observed order suppresses the final permit even without a candidate or BullMQ job", async () => {
    const db = client(); const { input } = await seed(db);
    await db.checkoutRecoveryStatusHistory.create({ data: {
      checkoutRecoveryId: input.recoveryId, fromStatus: "DETECTED", toStatus: "CANCELLED",
      reason: "woo-order-cancelled", source: "woocommerce.order",
      metadata: { orderId: "order-1" },
    } });
    expect(await new WooInitialSendFenceService(db).admitFinalSend(input))
      .toEqual({ kind: "suppressed", reason: "woo-observed-order-terminal" });
    expect((await db.conversationMessage.findUniqueOrThrow({ where: { id: input.messageId } })).providerDispatchKey)
      .toBeNull();
  });

  it("changed consent or recipient, revoked installation, and terminal recovery all deny", async () => {
    const db = client();
    const fence = new WooInitialSendFenceService(db);

    // A real Woo REVOKE increments both revisions with corresponding immutable
    // evidence; direct database edits without that evidence are not legal.
    const revoked = await seed(db);
    const identity = {
      shopId: revoked.shopId, installationId: revoked.input.consent.installationId,
      customerId: revoked.input.customerId,
      customerPhoneId: revoked.input.consent.customerPhoneId,
    };
    await recordWooDecision(db, identity, "REVOKE");
    expect((await fence.admitFinalSend(revoked.input)).kind).toBe("suppressed");

    // Rotation requires a withdrawal followed by a new, evidenced opt-in;
    // changing an already GRANTED canonical number in place is forbidden.
    const rotated = await seed(db);
    const rotationIdentity = {
      shopId: rotated.shopId, installationId: rotated.input.consent.installationId,
      customerId: rotated.input.customerId,
      customerPhoneId: rotated.input.consent.customerPhoneId,
    };
    await recordWooDecision(db, rotationIdentity, "REVOKE");
    await recordWooDecision(db, rotationIdentity, "GRANT", "447400555555");
    expect((await fence.admitFinalSend(rotated.input)).kind).toBe("suppressed");

    const disconnected = await seed(db);
    await db.wooCommerceInstallation.update({ where: { id: disconnected.input.consent.installationId },
      data: { status: "REVOKED", revokedAt: new Date() } });
    expect((await fence.admitFinalSend(disconnected.input)).kind).toBe("suppressed");

    const terminal = await seed(db);
    await db.checkoutRecovery.update({ where: { id: terminal.input.recoveryId }, data: {
      status: "COMPLETED", completedAt: new Date(),
    } });
    expect((await fence.admitFinalSend(terminal.input)).kind).toBe("suppressed");
    for (const context of [revoked, rotated, disconnected, terminal]) {
      const message = await db.conversationMessage.findUniqueOrThrow({ where: { id: context.input.messageId } });
      expect(message.providerDispatchKey).toBeNull();
    }
  });

  it("STOP after committed admission cannot retroactively retract the provider permit", async () => {
    const db = client(); const { input, shopId } = await seed(db);
    expect(await new WooInitialSendFenceService(db).admitFinalSend(input)).toEqual({ kind: "admitted" });
    await writeLocalStop(db, { canonical: DIGITS, shopId, eventId: randomUUID(), at: new Date() });
    const message = await db.conversationMessage.findUniqueOrThrow({ where: { id: input.messageId } });
    expect(message.providerDispatchKey).toBeTruthy();
    expect((await new WooInitialSendFenceService(db).admitFinalSend(input)).kind).toBe("suppressed");
  });
});
