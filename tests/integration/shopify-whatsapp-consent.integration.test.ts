import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ShopifyWhatsAppConsentService } from "../../src/services/shopify-whatsapp-consent.service.js";
import type {
  ShopifyWhatsAppConsentObservation,
  ShopifyWhatsAppConsentReader,
} from "../../src/providers/shopify-whatsapp-consent.provider.js";

const url = process.env.TEST_DATABASE_URL;
const describeWithDatabase = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

const gid = "gid://shopify/Customer/125678912345";
const native = (state: "SUBSCRIBED" | "UNSUBSCRIBED", updatedAt: string,
  phoneNumber = "+447400123456"): ShopifyWhatsAppConsentObservation => ({
  kind: "OBSERVED", customerGid: gid, phoneNumber, state, updatedAt,
});
const t1 = "2026-10-20T08:00:00Z";
const t2 = "2026-10-21T08:00:00Z";
const t3 = "2026-10-22T08:00:00Z";

function service(db: PrismaClient, outcome: ShopifyWhatsAppConsentObservation | ShopifyWhatsAppConsentReader) {
  const reader: ShopifyWhatsAppConsentReader = "kind" in outcome
    ? { readCurrent: vi.fn(async () => outcome) }
    : outcome;
  return new ShopifyWhatsAppConsentService(reader, db, () => new Date("2026-10-22T12:00:00Z"));
}

describeWithDatabase("ARCH-045 native Shopify consent PostgreSQL projection", () => {
  it("persists only the exact active CustomerPhone, keeps no-contact revisions independent and rejects out-of-order reads", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const suffix = randomUUID().replaceAll("-", "");
    const shop = `consent-a-${suffix}`;
    const other = `consent-b-${suffix}`;
    try {
      await db.shop.createMany({ data: [
        { id: shop, domain: `${shop}.myshopify.com`, platform: "SHOPIFY", defaultCountryCode: "GB" },
        { id: other, domain: `${other}.myshopify.com`, platform: "SHOPIFY", defaultCountryCode: "GB" },
      ] });
      const a = await db.customer.create({ data: { shopId: shop, shopifyCustomerId: "125678912345" } });
      const b = await db.customer.create({ data: { shopId: other, shopifyCustomerId: "125678912345" } });
      const legacy = await db.customer.create({ data: { shopId: shop, phone: "+447400123456" } });
      const ap = await db.customerPhone.create({ data: { customerId: a.id, phone: "07400 123456" } });
      const bp = await db.customerPhone.create({ data: { customerId: b.id, phone: "+447400123456" } });
      await db.customerPhone.create({ data: { customerId: legacy.id, phone: "+447700900456" } });

      const identity = { shopId: shop, shopifyCustomerId: gid };
      const admitted = { ...identity, customerId: a.id, recipient: "+447400123456" };
      const granted = service(db, native("SUBSCRIBED", t1));
      expect((await granted.evaluateRecipient(admitted)).status).toBe("ALLOWED");
      const afterGrant = await db.customerPhone.findUniqueOrThrow({ where: { id: ap.id } });
      expect(afterGrant).toMatchObject({
        whatsappCanonicalPhone: "447400123456", whatsappConsentSource: "SHOPIFY_NATIVE",
        whatsappConsentDecision: "GRANTED", whatsappConsentRevision: 1n,
        whatsappConsentDecisionSequence: 1n,
      });
      expect(await db.customerPhone.findUniqueOrThrow({ where: { id: bp.id } })).toMatchObject({
        whatsappConsentDecision: "UNKNOWN", whatsappConsentRevision: 0n,
      });
      expect((await granted.syncCustomer(identity)).status).toBe("UNCHANGED");
      expect((await db.customerPhone.findUniqueOrThrow({ where: { id: ap.id } })).whatsappConsentRevision).toBe(1n);
      expect((await granted.evaluateRecipient({ ...admitted, customerId: legacy.id })).status).toBe("NOT_AUTHORISED");
      expect((await db.customer.findUniqueOrThrow({ where: { id: legacy.id } })).shopifyCustomerId).toBeNull();

      // A local STOP is independently committed. Neither a later Shopify grant
      // nor a callback retry has authority to remove it.
      await db.customerPhone.update({ where: { id: ap.id }, data: {
        whatsappNoContact: true, whatsappNoContactReason: "CUSTOMER_STOP",
        whatsappNoContactAt: new Date("2026-10-21T07:00:00Z"),
        whatsappNoContactRevision: { increment: 1 },
      } });
      const renewed = service(db, native("SUBSCRIBED", t2));
      expect((await renewed.syncCustomer(identity)).status).toBe("UPDATED");
      expect((await renewed.evaluateStoredRecipient({ shopId: shop, customerId: a.id, recipient: admitted.recipient })).status)
        .toBe("NOT_AUTHORISED");
      const afterStopGrant = await db.customerPhone.findUniqueOrThrow({ where: { id: ap.id } });
      expect(afterStopGrant).toMatchObject({
        whatsappConsentDecision: "GRANTED", whatsappConsentRevision: 2n,
        whatsappNoContact: true, whatsappNoContactReason: "CUSTOMER_STOP", whatsappNoContactRevision: 1n,
      });

      // Two asynchronous provider responses finish out of order. The later
      // Shopify observedAt must win, not the order the workers complete.
      let finishOld!: () => void;
      const blocked = new Promise<void>((resolve) => { finishOld = resolve; });
      let oldStarted!: () => void;
      const oldStartedPromise = new Promise<void>((resolve) => { oldStarted = resolve; });
      const outdated = service(db, { readCurrent: async () => {
        oldStarted();
        await blocked;
        return native("SUBSCRIBED", t1);
      } });
      const staleOperation = outdated.syncCustomer(identity);
      await oldStartedPromise;
      const revoke = service(db, native("UNSUBSCRIBED", t3));
      expect((await revoke.syncCustomer(identity)).status).toBe("UPDATED");
      finishOld();
      expect((await staleOperation).status).toBe("UNAVAILABLE");
      const final = await db.customerPhone.findUniqueOrThrow({ where: { id: ap.id } });
      expect(final).toMatchObject({
        whatsappConsentDecision: "REVOKED", whatsappConsentRevision: 3n,
        whatsappConsentDecisionSequence: 3n, whatsappNoContact: true, whatsappNoContactRevision: 1n,
      });
      expect((await revoke.evaluateStoredRecipient({ shopId: shop, customerId: a.id, recipient: admitted.recipient })).status)
        .toBe("NOT_AUTHORISED");
    } finally {
      await db.shop.deleteMany({ where: { id: { in: [shop, other] } } });
      await db.$disconnect();
    }
  });

  it("invalidates a newer grant on a changed default with older updatedAt, without regranting or altering STOP", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const suffix = randomUUID().replaceAll("-", "");
    const shopId = `consent-stale-default-${suffix}`;
    try {
      await db.shop.create({ data: {
        id: shopId, domain: `${shopId}.myshopify.com`, platform: "SHOPIFY", defaultCountryCode: "GB",
      } });
      const customer = await db.customer.create({ data: { shopId, shopifyCustomerId: "125678912345" } });
      const a = await db.customerPhone.create({ data: {
        customerId: customer.id, phone: "+447400123456",
      } });
      const b = await db.customerPhone.create({ data: {
        customerId: customer.id, phone: "+447400123457",
        whatsappNoContact: true, whatsappNoContactReason: "CUSTOMER_STOP",
        whatsappNoContactAt: new Date("2026-10-21T09:00:00Z"),
        whatsappNoContactRevision: 4n,
      } });
      const identity = { shopId, shopifyCustomerId: gid };
      const recipientA = { shopId, customerId: customer.id, recipient: "+447400123456" };
      const recipientB = { shopId, customerId: customer.id, recipient: "+447400123457" };
      expect((await service(db, native("SUBSCRIBED", t3)).syncCustomer(identity)).status).toBe("UPDATED");
      expect((await service(db, native("SUBSCRIBED", t3)).evaluateStoredRecipient(recipientA)).status)
        .toBe("ALLOWED");

      // The new default B reports an earlier *consent* timestamp (t1). It
      // must invalidate A, but cannot override A's provider observation (t3)
      // or turn B into an affirmative grant based on the older observation.
      expect(await service(db, native("SUBSCRIBED", t1, "+447400123457")).syncCustomer(identity)).toEqual({
        status: "UNAVAILABLE", reason: "STALE_OR_CONFLICTING_OBSERVATION",
      });
      const afterA = await db.customerPhone.findUniqueOrThrow({ where: { id: a.id } });
      const afterB = await db.customerPhone.findUniqueOrThrow({ where: { id: b.id } });
      expect(afterA).toMatchObject({
        // Identity invalidation is not a new provider consent observation.
        whatsappConsentSource: null, whatsappConsentDecision: "UNKNOWN",
        whatsappConsentProviderObservedAt: new Date(t3), whatsappConsentRevision: 2n,
        whatsappConsentDecisionSequence: 2n, whatsappNoContact: false,
      });
      expect(afterB).toMatchObject({
        whatsappConsentDecision: "UNKNOWN", whatsappConsentProviderObservedAt: null,
        whatsappConsentRevision: 0n, whatsappNoContact: true,
        whatsappNoContactReason: "CUSTOMER_STOP", whatsappNoContactRevision: 4n,
        whatsappNoContactAt: new Date("2026-10-21T09:00:00Z"),
      });
      expect((await service(db, native("SUBSCRIBED", t1)).evaluateStoredRecipient(recipientA)).status)
        .toBe("NOT_AUTHORISED");
      expect((await service(db, native("SUBSCRIBED", t1)).evaluateStoredRecipient(recipientB)).status)
        .toBe("NOT_AUTHORISED");
      // Duplicate and slightly later-but-still-stale observations must not
      // grant B now that A's source is null. Its stored timestamp remains an
      // ordering fence even though its native grant is withdrawn.
      expect(await service(db, native("SUBSCRIBED", t1, "+447400123457")).syncCustomer(identity)).toEqual({
        status: "UNAVAILABLE", reason: "STALE_OR_CONFLICTING_OBSERVATION",
      });
      expect((await service(db, native("SUBSCRIBED", t2, "+447400123457")).syncCustomer(identity)).status)
        .toBe("UNAVAILABLE");
      expect((await db.customerPhone.findUniqueOrThrow({ where: { id: a.id } })).whatsappConsentDecision)
        .toBe("UNKNOWN");
      expect((await db.customerPhone.findUniqueOrThrow({ where: { id: b.id } })).whatsappConsentDecision)
        .toBe("UNKNOWN");
      // A truly newer observation can project B, but its independent local
      // STOP continues to override that native grant for outbound eligibility.
      const t4 = "2026-10-22T10:00:00Z";
      expect((await service(db, native("SUBSCRIBED", t4, "+447400123457")).syncCustomer(identity)).status)
        .toBe("UPDATED");
      expect((await service(db, native("SUBSCRIBED", t4)).evaluateStoredRecipient(recipientB)).status)
        .toBe("NOT_AUTHORISED");
      expect(await db.customerPhone.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({
        whatsappConsentDecision: "GRANTED", whatsappConsentSource: "SHOPIFY_NATIVE",
        whatsappNoContact: true, whatsappNoContactReason: "CUSTOMER_STOP",
        whatsappNoContactRevision: 4n,
      });
    } finally {
      await db.shop.deleteMany({ where: { id: shopId } });
      await db.$disconnect();
    }
  });

  it("refuses a changed Shopify default recipient, and refuses cross-customer matching within one shop", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const suffix = randomUUID().replaceAll("-", "");
    const shopId = `consent-c-${suffix}`;
    try {
      await db.shop.create({ data: { id: shopId, domain: `${shopId}.myshopify.com`, platform: "SHOPIFY", defaultCountryCode: "GB" } });
      const customer = await db.customer.create({ data: { shopId, shopifyCustomerId: "125678912345" } });
      const record = await db.customerPhone.create({ data: { customerId: customer.id, phone: "+447400123456" } });
      const input = { shopId, customerId: customer.id, shopifyCustomerId: gid, recipient: "+447400123456" };
      expect((await service(db, native("SUBSCRIBED", t1)).evaluateRecipient(input)).status).toBe("ALLOWED");
      expect((await service(db, native("SUBSCRIBED", t2, "+447400123457")).evaluateRecipient(input)).status)
        .toBe("NOT_AUTHORISED");
      expect((await db.customerPhone.findUniqueOrThrow({ where: { id: record.id } })).whatsappConsentDecision).toBe("UNKNOWN");
      expect((await service(db, native("SUBSCRIBED", t3)).evaluateStoredRecipient({ shopId, customerId: customer.id, recipient: input.recipient })).status)
        .toBe("NOT_AUTHORISED");

      const other = await db.customer.create({ data: { shopId, shopifyCustomerId: "123456789" } });
      await db.customerPhone.create({ data: {
        customerId: other.id, phone: "+447400123456", whatsappCanonicalPhone: "447400123456",
      } });
      expect((await service(db, native("SUBSCRIBED", t3)).evaluateRecipient(input)).status).toBe("AMBIGUOUS");
    } finally {
      await db.shop.deleteMany({ where: { id: shopId } });
      await db.$disconnect();
    }
  });
});
