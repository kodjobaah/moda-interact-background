import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { WhatsAppContactOptOutService } from "../../src/services/whatsapp-contact-opt-out.service.js";
import { hasLocalNoContact } from "../../src/services/whatsapp-contact-opt-out/local-no-contact.js";
import { publishStopNotices, writeLocalStop } from "../../src/services/whatsapp-contact-opt-out/stop-writer.js";
import { ShopifyWhatsAppConsentService } from "../../src/services/shopify-whatsapp-consent.service.js";
import type { WhatsAppInboundEvent } from "../../src/integration/whatsapp/types.js";

const url = process.env.TEST_DATABASE_URL;
const describeWithDatabase = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
const phone = "+447400123456";
const canonical = phone.slice(1);
const now = new Date("2026-10-22T19:00:00Z");
const incoming = (patch: Record<string, unknown> = {}): WhatsAppInboundEvent => ({
  schemaVersion: 1, provider: "whatsapp", providerAccountId: "waba-1", providerPhoneNumberId: "phone-1",
  providerMessageId: `wamid-${randomUUID()}`, customerPhone: canonical,
  contextMessageId: null, occurredAt: "2026-10-22T18:00:00Z",
  content: { type: "text", text: "STOP" }, ...patch,
} as WhatsAppInboundEvent);
const sender = async () => ({ providerAccountId: "waba-1", providerPhoneNumberId: "phone-1" });
const optOut = (db: PrismaClient) => new WhatsAppContactOptOutService(db, sender, undefined, () => now);

describeWithDatabase("ARCH-045 WhatsApp STOP PostgreSQL", () => {
  it("updates Shopify and Woo registered phones, never another number; duplicate, later Shopify grant and merchant re-enable cannot clear STOP", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const suffix = randomUUID().replaceAll("-", "");
    const shopA = `stop-a-${suffix}`;
    const shopB = `stop-b-${suffix}`;
    try {
      await db.shop.createMany({ data: [
        { id: shopA, domain: `${shopA}.myshopify.com`, platform: "SHOPIFY", defaultCountryCode: "GB" },
        { id: shopB, domain: `${shopB}.example.com`, platform: "WOOCOMMERCE", defaultCountryCode: "GB" },
      ] });
      const a = await db.customer.create({ data: { shopId: shopA, shopifyCustomerId: "125678912345" } });
      const a2 = await db.customer.create({ data: { shopId: shopA } });
      const b = await db.customer.create({ data: { shopId: shopB } });
      const ap = await db.customerPhone.create({ data: { customerId: a.id, phone, whatsappCanonicalPhone: canonical } });
      const bp = await db.customerPhone.create({ data: { customerId: b.id, phone, whatsappCanonicalPhone: canonical } });
      const different = await db.customerPhone.create({ data: { customerId: b.id, phone: "+447400123457" } });
      const identity = { shopId: shopA, shopifyCustomerId: "gid://shopify/Customer/125678912345" };
      const first = new ShopifyWhatsAppConsentService({ readCurrent: vi.fn(async () => ({
        kind: "OBSERVED" as const, customerGid: identity.shopifyCustomerId, phoneNumber: phone,
        state: "SUBSCRIBED" as const, updatedAt: "2026-10-21T10:00:00Z",
      })) }, db, () => now);
      expect((await first.syncCustomer(identity)).status).toBe("UPDATED");
      // The legacy same-shop matching number is registered after the native
      // grant; positive consent never transfers to another Customer by phone.
      const ap2 = await db.customerPhone.create({ data: { customerId: a2.id, phone: "07400 123456" } });
      const stop = incoming({ providerMessageId: `wamid-${suffix}` });
      expect(await optOut(db).handleInbound(stop)).toBe(true);
      const all = await db.customerPhone.findMany({ where: { id: { in: [ap.id, ap2.id, bp.id, different.id] } } });
      expect(all.filter((r) => r.whatsappNoContact)).toHaveLength(3);
      expect(all.find((r) => r.id === different.id)!.whatsappNoContact).toBe(false);
      expect(all.filter((r) => r.whatsappNoContact).every((r) => r.whatsappNoContactReason === "CUSTOMER_STOP")).toBe(true);
      expect(await hasLocalNoContact(db, { shopId: shopA, recipient: phone })).toBe(true);
      expect(await hasLocalNoContact(db, { shopId: shopB, recipient: phone })).toBe(true);
      expect(await hasLocalNoContact(db, { shopId: shopB, recipient: "+447400123457" })).toBe(false);
      const before = await db.customerPhone.findUniqueOrThrow({ where: { id: ap.id } });
      expect(await optOut(db).handleInbound(stop)).toBe(true);
      const after = await db.customerPhone.findUniqueOrThrow({ where: { id: ap.id } });
      expect(after.whatsappNoContactRevision).toBe(before.whatsappNoContactRevision);
      expect(after.whatsappNoContactAt).toEqual(before.whatsappNoContactAt);
      // End the deliberately ambiguous second CustomerPhone before independently
      // checking a later Shopify observation for the identified customer.
      await db.customerPhone.update({ where: { id: ap2.id }, data: { endedAt: now } });
      const renew = new ShopifyWhatsAppConsentService({ readCurrent: vi.fn(async () => ({
        kind: "OBSERVED" as const, customerGid: identity.shopifyCustomerId,
        phoneNumber: phone, state: "SUBSCRIBED" as const, updatedAt: "2026-10-22T16:00:00Z",
      })) }, db, () => now);
      expect((await renew.syncCustomer(identity)).status).toBe("UPDATED");
      expect((await renew.evaluateStoredRecipient({ shopId: shopA, customerId: a.id, recipient: phone })).status)
        .toBe("NOT_AUTHORISED");
      const final = await db.customerPhone.findUniqueOrThrow({ where: { id: ap.id } });
      expect(final).toMatchObject({ whatsappConsentDecision: "GRANTED", whatsappNoContact: true,
        whatsappNoContactReason: "CUSTOMER_STOP", whatsappNoContactRevision: before.whatsappNoContactRevision });
      await expect(db.customerPhone.update({ where: { id: bp.id }, data: {
        whatsappNoContact: false, whatsappNoContactReason: null,
        whatsappNoContactClearedAt: new Date("2026-10-22T19:01:00Z"),
        whatsappNoContactRevision: { increment: 1 },
      } })).rejects.toThrow();
      const notices = await db.merchantSupportMessage.findMany({
        where: { thread: { shopId: { in: [shopA, shopB] } }, systemCode: "WHATSAPP_CUSTOMER_STOP" },
      });
      expect(notices).toHaveLength(2);
      expect(notices.every((n) => n.kind === "SYSTEM" && n.state === "AVAILABLE")).toBe(true);
      expect(notices.every((n) => !n.sourceKey?.includes(canonical) && !n.originalBody.includes(phone))).toBe(true);
    } finally {
      await db.shop.deleteMany({ where: { id: { in: [shopA, shopB] } } });
      await db.$disconnect();
    }
  });

  it("quoted STOP blocks only its verified shop; unresolvable quoted STOP falls back to every shop", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const suffix = randomUUID().replaceAll("-", "");
    const shopA = `quoted-a-${suffix}`;
    const shopB = `quoted-b-${suffix}`;
    try {
      await db.shop.createMany({ data: [
        { id: shopA, domain: `${shopA}.myshopify.com`, platform: "SHOPIFY", defaultCountryCode: "GB" },
        { id: shopB, domain: `${shopB}.myshopify.com`, platform: "SHOPIFY", defaultCountryCode: "GB" },
      ] });
      const a = await db.customer.create({ data: { shopId: shopA, phone } });
      const b = await db.customer.create({ data: { shopId: shopB, phone } });
      const ap = await db.customerPhone.create({ data: { customerId: a.id, phone, whatsappCanonicalPhone: canonical } });
      const bp = await db.customerPhone.create({ data: { customerId: b.id, phone, whatsappCanonicalPhone: canonical } });
      const recovery = await db.checkoutRecovery.create({ data: {
        shopId: shopA, customerId: a.id, checkoutToken: `checkout-${suffix}`,
        lastExternalActivityAt: now,
      } });
      const conversation = await db.conversation.create({ data: {
        type: "RECOVERY", checkoutRecoveryId: recovery.id,
      } });
      const originalId = `wamid-original-${suffix}`;
      await db.conversationMessage.create({ data: {
        conversationId: conversation.id, providerMessageId: originalId,
        direction: "OUTBOUND", senderType: "AUTOMATION", content: "Your basket",
        status: "SENT", sentAt: now,
      } });
      await optOut(db).handleInbound(incoming({ contextMessageId: originalId }));
      expect((await db.customerPhone.findUniqueOrThrow({ where: { id: ap.id } })).whatsappNoContact).toBe(true);
      expect((await db.customerPhone.findUniqueOrThrow({ where: { id: bp.id } })).whatsappNoContact).toBe(false);
      await optOut(db).handleInbound(incoming({ contextMessageId: "unknown-quoted-provider-id" }));
      expect((await db.customerPhone.findUniqueOrThrow({ where: { id: bp.id } })).whatsappNoContact).toBe(true);
    } finally {
      await db.shop.deleteMany({ where: { id: { in: [shopA, shopB] } } });
      await db.$disconnect();
    }
  });

  it("resumes partial merchant Support publication from durable STOP without duplicating notices", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const suffix = randomUUID().replaceAll("-", "");
    const shops = [`notice-a-${suffix}`, `notice-b-${suffix}`];
    try {
      await db.shop.createMany({ data: shops.map((id) => ({
        id, domain: `${id}.myshopify.com`, platform: "SHOPIFY" as const, defaultCountryCode: "GB",
      })) });
      for (const shopId of shops) {
        const customer = await db.customer.create({ data: { shopId } });
        await db.customerPhone.create({ data: { customerId: customer.id, phone, whatsappCanonicalPhone: canonical } });
      }
      const written = await writeLocalStop(db, {
        canonical, shopId: null, eventId: `wamid-${suffix}`, at: now,
      });
      expect(written.notices).toHaveLength(2);
      expect(written.changed).toBe(2);
      await publishStopNotices(db, written.notices.slice(0, 1), "ALL_REGISTERED_SHOPS");
      expect(await db.merchantSupportMessage.count({ where: { systemCode: "WHATSAPP_CUSTOMER_STOP",
        thread: { shopId: { in: shops } } } })).toBe(1);
      await publishStopNotices(db, written.notices, "ALL_REGISTERED_SHOPS");
      await publishStopNotices(db, written.notices, "ALL_REGISTERED_SHOPS");
      expect(await db.merchantSupportMessage.count({ where: { systemCode: "WHATSAPP_CUSTOMER_STOP",
        thread: { shopId: { in: shops } } } })).toBe(2);
    } finally {
      await db.shop.deleteMany({ where: { id: { in: shops } } });
      await db.$disconnect();
    }
  });
});
