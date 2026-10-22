import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  WooRecoveryConsentReader,
  type WooRecoveryConsentReadInput,
} from "../../src/services/woocommerce-recovery-consent.service.js";

const url = process.env.TEST_DATABASE_URL;
const describeWithDatabase = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
const PHONE = "+447400123456";
const DIGITS = "447400123456";
const START = new Date("2026-10-22T10:00:00Z");

async function makeShop(db: PrismaClient, country: string | null = "GB") {
  const id = randomUUID();
  const shop = await db.shop.create({ data: {
    id, domain: `https://${id}.example.test`, platform: "WOOCOMMERCE", status: "ACTIVE",
    defaultCountryCode: country,
  } });
  const installation = await db.wooCommerceInstallation.create({ data: {
    shopId: id, canonicalSiteUrl: shop.domain, credentialDigest: Uint8Array.from(randomBytes(32)),
  } });
  return { shop, installation };
}

async function makeCustomer(db: PrismaClient, shopId: string, phone = PHONE) {
  const customer = await db.customer.create({ data: { shopId, phone } });
  const record = await db.customerPhone.create({ data: {
    customerId: customer.id, phone, startedAt: START,
  } });
  return { customer, phone: record };
}

/** Real migration enforces Woo grant + immutable evidence in the same transaction. */
async function decision(db: PrismaClient, input: {
  shopId: string; installationId: string; customerId: string; phoneId: string;
  kind: "GRANT" | "REVOKE"; sequence: number;
}) {
  const at = new Date(START.getTime() + input.sequence * 10_000);
  await db.$transaction(async (tx) => {
    const updated = await tx.customerPhone.update({ where: { id: input.phoneId }, data: {
      whatsappCanonicalPhone: DIGITS,
      whatsappPhoneVerifiedAt: at,
      whatsappConsentPurpose: "WHATSAPP_CHECKOUT_RECOVERY",
      whatsappConsentDecision: input.kind === "GRANT" ? "GRANTED" : "REVOKED",
      whatsappConsentSource: "WOO_MODA_CHECKBOX",
      whatsappConsentProviderObservedAt: at,
      whatsappConsentVerifiedAt: at,
      whatsappConsentRevision: { increment: 1 },
      whatsappConsentDecisionSequence: { increment: 1 },
    } });
    await tx.whatsAppConsentEvidence.create({ data: {
      shopId: input.shopId, installationId: input.installationId,
      id: randomUUID(), eventId: `woo-test-${randomUUID()}`,
      payloadDigest: Uint8Array.from(randomBytes(32)),
      customerId: input.customerId, customerPhoneId: input.phoneId,
      canonicalPhone: DIGITS, decision: input.kind,
      decisionSequence: updated.whatsappConsentDecisionSequence,
      phoneConsentRevision: updated.whatsappConsentRevision, decisionAt: at,
      ...(input.kind === "GRANT" ? {
        disclosureText: "I agree to WhatsApp abandoned-checkout marketing messages",
        disclosureVersion: "woo-test-v1", disclosureLocale: "en-GB",
      } : {}),
    } });
  });
}

const job = (shopId: string, recipient = PHONE): WooRecoveryConsentReadInput =>
  ({ context: { kind: "JOB", shopId }, recipient });
const status = (result: Awaited<ReturnType<WooRecoveryConsentReader["evaluateRecipient"]>>) =>
  result.status === "ALLOWED" ? "ALLOWED" : `${result.status}:${result.reason}`;

describeWithDatabase("ARCH-046 Woo consent reader against migrated PostgreSQL", () => {
  it("reads one verified active phone, never inherits another shop's grant, denies same-shop duplicates and national ambiguity", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    try {
      const a = await makeShop(db);
      const b = await makeShop(db);
      const aCustomer = await makeCustomer(db, a.shop.id);
      const bCustomer = await makeCustomer(db, b.shop.id);
      const reader = new WooRecoveryConsentReader(db);
      expect(status(await reader.evaluateRecipient(job(a.shop.id)))).toBe("NOT_AUTHORISED:RECIPIENT_NOT_VERIFIED");
      await decision(db, { shopId: a.shop.id, installationId: a.installation.id,
        customerId: aCustomer.customer.id, phoneId: aCustomer.phone.id, kind: "GRANT", sequence: 1 });
      const allowed = await reader.evaluateRecipient(job(a.shop.id));
      expect(allowed).toMatchObject({ status: "ALLOWED", canonicalRecipient: DIGITS,
        customerPhoneId: aCustomer.phone.id, consentRevision: 1n, noContactRevision: 0n });
      expect(status(await reader.evaluateRecipient(job(b.shop.id))))
        .toBe("NOT_AUTHORISED:RECIPIENT_NOT_VERIFIED");
      expect(status(await reader.evaluateRecipient({ ...job(a.shop.id), expectedCustomerId: bCustomer.customer.id })))
        .toBe("NOT_AUTHORISED:CUSTOMER_IDENTITY_CHANGED");
      // A quoted STOP scoped to shop B must not suppress shop A, even when
      // the exact canonical phone is registered with both merchants.
      await decision(db, { shopId: b.shop.id, installationId: b.installation.id,
        customerId: bCustomer.customer.id, phoneId: bCustomer.phone.id, kind: "GRANT", sequence: 1 });
      await db.customerPhone.update({ where: { id: bCustomer.phone.id }, data: {
        whatsappNoContact: true, whatsappNoContactReason: "CUSTOMER_STOP",
        whatsappNoContactAt: new Date(START.getTime() + 20_000), whatsappNoContactRevision: { increment: 1 },
      } });
      expect(status(await reader.evaluateRecipient(job(b.shop.id))))
        .toBe("NOT_AUTHORISED:LOCAL_NO_CONTACT");
      expect(status(await reader.evaluateRecipient(job(a.shop.id)))).toBe("ALLOWED");
      const duplicated = await makeCustomer(db, a.shop.id, "07400 123456");
      expect(status(await reader.evaluateRecipient(job(a.shop.id))))
        .toBe("AMBIGUOUS:RECIPIENT_SHARED_BY_CUSTOMERS");
      // A different presentation of the same number remains ambiguous even when
      // the second row has never itself granted consent.
      expect((await db.customerPhone.findUniqueOrThrow({ where: { id: duplicated.phone.id } }))
        .whatsappConsentDecision).toBe("UNKNOWN");
      await db.customerPhone.update({ where: { id: duplicated.phone.id }, data: { endedAt: new Date() } });
      expect(status(await reader.evaluateRecipient(job(a.shop.id, "07400 123456")))).toBe("ALLOWED");
      await db.shop.update({ where: { id: a.shop.id }, data: { defaultCountryCode: null } });
      expect(status(await reader.evaluateRecipient(job(a.shop.id, "07400 123456"))))
        .toBe("NOT_AUTHORISED:INVALID_RECIPIENT_COUNTRY_REQUIRED");
      expect(status(await reader.evaluateRecipient(job(a.shop.id, PHONE)))).toBe("ALLOWED");
      // No read creates recovery, usage, message or audit evidence.
      expect(await db.checkoutRecovery.count({ where: { shopId: a.shop.id } })).toBe(0);
      expect(await db.whatsAppConsentEvidence.count({ where: { shopId: a.shop.id } })).toBe(1);
    } finally { await db.$disconnect(); }
  }, 45_000);

  it("fences withdrawal, phone replacement, merchant suppression, re-enable and authoritative STOP", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    try {
      const a = await makeShop(db);
      const record = await makeCustomer(db, a.shop.id);
      const reader = new WooRecoveryConsentReader(db);
      await decision(db, { shopId: a.shop.id, installationId: a.installation.id,
        customerId: record.customer.id, phoneId: record.phone.id, kind: "GRANT", sequence: 1 });
      const first = await reader.evaluateRecipient(job(a.shop.id));
      expect(first.status).toBe("ALLOWED");
      if (first.status !== "ALLOWED") return;
      await db.customerPhone.update({ where: { id: record.phone.id }, data: {
        whatsappNoContact: true, whatsappNoContactReason: "MERCHANT_OPT_OUT",
        whatsappNoContactAt: new Date(START.getTime() + 20_000), whatsappNoContactRevision: { increment: 1 },
      } });
      expect(status(await reader.evaluateRecipient(job(a.shop.id))))
        .toBe("NOT_AUTHORISED:LOCAL_NO_CONTACT");
      await db.customerPhone.update({ where: { id: record.phone.id }, data: {
        whatsappNoContact: false, whatsappNoContactReason: null,
        whatsappNoContactRevision: { increment: 1 },
        whatsappNoContactClearedAt: new Date(START.getTime() + 30_000),
      } });
      expect(status(await reader.evaluateRecipient({ ...job(a.shop.id), expected: first.snapshot })))
        .toBe("NOT_AUTHORISED:STALE_RECIPIENT_SNAPSHOT");
      expect(status(await reader.evaluateRecipient(job(a.shop.id)))).toBe("ALLOWED");
      await decision(db, { shopId: a.shop.id, installationId: a.installation.id,
        customerId: record.customer.id, phoneId: record.phone.id, kind: "REVOKE", sequence: 4 });
      expect(status(await reader.evaluateRecipient(job(a.shop.id))))
        .toBe("NOT_AUTHORISED:WOO_MARKETING_CONSENT_NOT_GRANTED");
      // Moving to a different active phone does not migrate permission.
      await db.customerPhone.update({ where: { id: record.phone.id }, data: { endedAt: new Date() } });
      await db.customerPhone.create({ data: { customerId: record.customer.id, phone: "+447400123457" } });
      expect(status(await reader.evaluateRecipient(job(a.shop.id, "+447400123457"))))
        .toBe("NOT_AUTHORISED:RECIPIENT_NOT_VERIFIED");
      expect(status(await reader.evaluateRecipient(job(a.shop.id))))
        .toBe("NOT_AUTHORISED:ACTIVE_RECIPIENT_NOT_FOUND");

      const stopRow = await makeCustomer(db, a.shop.id, "+447400123458");
      // For the STOP case, deliberately bind consent to the new recipient,
      // then prove that a later checkbox grant cannot clear local STOP.
      const stopDigits = "447400123458";
      const t = new Date(START.getTime() + 50_000);
      await db.$transaction(async tx => {
        const cp = await tx.customerPhone.update({ where: { id: stopRow.phone.id }, data: {
          whatsappCanonicalPhone: stopDigits, whatsappPhoneVerifiedAt: t,
          whatsappConsentDecision: "GRANTED", whatsappConsentSource: "WOO_MODA_CHECKBOX",
          whatsappConsentVerifiedAt: t, whatsappConsentProviderObservedAt: t,
          whatsappConsentRevision: { increment: 1 }, whatsappConsentDecisionSequence: { increment: 1 },
        } });
        await tx.whatsAppConsentEvidence.create({ data: {
          id: randomUUID(), shopId: a.shop.id, installationId: a.installation.id, eventId: randomUUID(),
          payloadDigest: Uint8Array.from(randomBytes(32)), customerId: stopRow.customer.id,
          customerPhoneId: stopRow.phone.id, canonicalPhone: stopDigits, decision: "GRANT",
          phoneConsentRevision: cp.whatsappConsentRevision,
          decisionSequence: cp.whatsappConsentDecisionSequence, decisionAt: t,
          disclosureText: "WhatsApp abandoned-basket marketing", disclosureLocale: "en-GB", disclosureVersion: "v1",
        } });
      });
      await db.customerPhone.update({ where: { id: stopRow.phone.id }, data: {
        whatsappNoContact: true, whatsappNoContactReason: "CUSTOMER_STOP",
        whatsappNoContactAt: new Date(START.getTime() + 60_000), whatsappNoContactRevision: { increment: 1 },
      } });
      expect(status(await reader.evaluateRecipient(job(a.shop.id, "+447400123458"))))
        .toBe("NOT_AUTHORISED:LOCAL_NO_CONTACT");
      await expect(db.customerPhone.update({ where: { id: stopRow.phone.id }, data: {
        whatsappNoContact: false, whatsappNoContactReason: null, whatsappNoContactRevision: { increment: 1 },
        whatsappNoContactClearedAt: new Date(START.getTime() + 70_000),
      } })).rejects.toThrow();
      expect(status(await reader.evaluateRecipient(job(a.shop.id, "+447400123458"))))
        .toBe("NOT_AUTHORISED:LOCAL_NO_CONTACT");
    } finally { await db.$disconnect(); }
  }, 45_000);

  it("requires an active installation, rejects stale auth and snapshots after reconnect, refuses inactive shops", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    try {
      const a = await makeShop(db);
      const record = await makeCustomer(db, a.shop.id);
      const reader = new WooRecoveryConsentReader(db);
      await decision(db, { shopId: a.shop.id, installationId: a.installation.id,
        customerId: record.customer.id, phoneId: record.phone.id, kind: "GRANT", sequence: 1 });
      const authenticated = { kind: "INSTALLATION" as const, shopId: a.shop.id,
        installationId: a.installation.id, credentialVersion: 1 };
      const granted = await reader.evaluateRecipient({ context: authenticated, recipient: PHONE });
      expect(granted.status).toBe("ALLOWED");
      if (granted.status !== "ALLOWED") return;
      await db.wooCommerceInstallation.update({ where: { id: a.installation.id },
        data: { credentialVersion: 2 } });
      expect(status(await reader.evaluateRecipient({ context: authenticated, recipient: PHONE })))
        .toBe("NOT_AUTHORISED:WOO_INSTALLATION_CHANGED");
      expect(status(await reader.evaluateRecipient({ ...job(a.shop.id), expected: granted.snapshot })))
        .toBe("NOT_AUTHORISED:STALE_RECIPIENT_SNAPSHOT");
      await db.wooCommerceInstallation.update({ where: { id: a.installation.id },
        data: { status: "REVOKED", revokedAt: new Date() } });
      expect(status(await reader.evaluateRecipient(job(a.shop.id))))
        .toBe("NOT_AUTHORISED:WOO_INSTALLATION_INACTIVE");
      await db.wooCommerceInstallation.update({ where: { id: a.installation.id },
        data: { status: "ACTIVE", revokedAt: null, credentialVersion: 3 } });
      expect(status(await reader.evaluateRecipient(job(a.shop.id)))).toBe("ALLOWED");
      await db.shop.update({ where: { id: a.shop.id }, data: { status: "SUSPENDED" } });
      expect(status(await reader.evaluateRecipient(job(a.shop.id)))).toBe("NOT_AUTHORISED:WOO_SHOP_INACTIVE");
    } finally { await db.$disconnect(); }
  }, 45_000);
});
