import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ShopifyWhatsAppConsentService,
} from "../../../src/services/shopify-whatsapp-consent.service.js";
import type {
  ShopifyWhatsAppConsentObservation,
  ShopifyWhatsAppConsentReader,
} from "../../../src/providers/shopify-whatsapp-consent.provider.js";

const GID = "gid://shopify/Customer/12345";
const SUBSCRIBED: ShopifyWhatsAppConsentObservation = {
  kind: "OBSERVED", customerGid: GID, phoneNumber: "+447400123456",
  state: "SUBSCRIBED", updatedAt: "2026-10-20T09:00:00Z",
};
const REVOKED: ShopifyWhatsAppConsentObservation = {
  ...SUBSCRIBED, state: "UNSUBSCRIBED", updatedAt: "2026-10-21T09:00:00Z",
};

type Phone = {
  id: string;
  customerId: string;
  phone: string;
  endedAt: Date | null;
  whatsappCanonicalPhone: string | null;
  whatsappPhoneVerifiedAt: Date | null;
  whatsappConsentPurpose: string;
  whatsappConsentDecision: string;
  whatsappConsentSource: string | null;
  whatsappConsentProviderObservedAt: Date | null;
  whatsappConsentVerifiedAt: Date | null;
  whatsappConsentRevision: bigint;
  whatsappConsentDecisionSequence: bigint;
  whatsappNoContact: boolean;
  whatsappNoContactReason: string | null;
  whatsappNoContactAt: Date | null;
  whatsappNoContactRevision: bigint;
  whatsappNoContactClearedAt: Date | null;
};

function phone(id = "phone-a", customerId = "customer-a", number = "+447400123456"): Phone {
  return {
    id, customerId, phone: number, endedAt: null, whatsappCanonicalPhone: null,
    whatsappPhoneVerifiedAt: null, whatsappConsentPurpose: "WHATSAPP_CHECKOUT_RECOVERY",
    whatsappConsentDecision: "UNKNOWN", whatsappConsentSource: null,
    whatsappConsentProviderObservedAt: null, whatsappConsentVerifiedAt: null,
    whatsappConsentRevision: 0n, whatsappConsentDecisionSequence: 0n,
    whatsappNoContact: false, whatsappNoContactReason: null, whatsappNoContactAt: null,
    whatsappNoContactRevision: 0n, whatsappNoContactClearedAt: null,
  };
}

function fakeDatabase() {
  const shops = [
    { id: "shop-a", domain: "a-shop.myshopify.com", platform: "SHOPIFY", status: "ACTIVE", defaultCountryCode: "GB" },
    { id: "shop-b", domain: "b-shop.myshopify.com", platform: "SHOPIFY", status: "ACTIVE", defaultCountryCode: "GB" },
  ];
  const customers = [
    { id: "customer-a", shopId: "shop-a", shopifyCustomerId: "12345" },
    { id: "customer-b", shopId: "shop-b", shopifyCustomerId: "12345" },
    { id: "legacy", shopId: "shop-a", shopifyCustomerId: null as string | null },
  ];
  const phones = [phone(), phone("phone-b", "customer-b")];
  let beforeUpdate: (() => void) | undefined;
  const db = {
    shop: { findUnique: vi.fn(async ({ where: { id } }: any) => shops.find((s) => s.id === id) ?? null) },
    customer: {
      findMany: vi.fn(async ({ where: { shopId, shopifyCustomerId }, take }: any) =>
        customers.filter((c) => c.shopId === shopId && shopifyCustomerId.in.includes(c.shopifyCustomerId)).slice(0, take)),
      findFirst: vi.fn(async ({ where: { shopId, id } }: any) => customers.find((c) => c.shopId === shopId && c.id === id) ?? null),
      create: vi.fn(), update: vi.fn(),
    },
    customerPhone: {
      findMany: vi.fn(async ({ where, take, select }: any) => phones.filter((p) => {
        const customer = customers.find((c) => c.id === p.customerId);
        if (where.customer?.shopId !== undefined && customer?.shopId !== where.customer.shopId) return false;
        if (where.customerId !== undefined && p.customerId !== where.customerId) return false;
        if (where.endedAt === null && p.endedAt !== null) return false;
        if (where.whatsappConsentSource !== undefined && p.whatsappConsentSource !== where.whatsappConsentSource) return false;
        if (where.whatsappConsentDecision !== undefined && p.whatsappConsentDecision !== where.whatsappConsentDecision) return false;
        if (where.whatsappCanonicalPhone === null && p.whatsappCanonicalPhone !== null) return false;
        if (where.OR && !where.OR.some((clause: any) =>
          clause.whatsappCanonicalPhone !== undefined ? p.whatsappCanonicalPhone === clause.whatsappCanonicalPhone :
          clause.phone?.in?.includes(p.phone))) return false;
        return true;
      }).slice(0, take ?? Infinity).map((p) => select ?
        Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, p[k as keyof Phone]])) : p)),
      findFirst: vi.fn(async ({ where }: any) => phones.find((p) =>
        p.id === where.id && p.customerId === where.customerId && p.endedAt === null &&
        customers.find((c) => c.id === p.customerId)?.shopId === where.customer.shopId) ?? null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const callback = beforeUpdate;
        beforeUpdate = undefined;
        callback?.();
        const row = phones.find((p) =>
          p.id === where.id && p.customerId === where.customerId && p.endedAt === null &&
          p.phone === where.phone && p.whatsappCanonicalPhone === where.whatsappCanonicalPhone &&
          p.whatsappConsentRevision === where.whatsappConsentRevision &&
          p.whatsappConsentDecisionSequence === where.whatsappConsentDecisionSequence);
        if (!row) return { count: 0 };
        // Emulates the native consent fields and revision CAS; no-contact is not
        // allowed in update payload and always remains independently mutable.
        for (const field of ["whatsappNoContact", "whatsappNoContactReason",
          "whatsappNoContactRevision", "whatsappNoContactAt", "whatsappNoContactClearedAt"]) {
          expect(data).not.toHaveProperty(field);
        }
        Object.assign(row, {
          ...data,
          whatsappConsentRevision: row.whatsappConsentRevision + BigInt(data.whatsappConsentRevision.increment),
          whatsappConsentDecisionSequence: row.whatsappConsentDecisionSequence + BigInt(data.whatsappConsentDecisionSequence.increment),
        });
        return { count: 1 };
      }),
    },
  };
  return {
    db: db as unknown as PrismaClient,
    shops, customers, phones, mocks: db,
    raceWith: (callback: () => void) => { beforeUpdate = callback; },
  };
}

function service(
  db: PrismaClient,
  observation: ShopifyWhatsAppConsentObservation | ShopifyWhatsAppConsentObservation[] = SUBSCRIBED,
) {
  const responses = Array.isArray(observation) ? [...observation] : [observation];
  const readCurrent = vi.fn(async () => responses.length > 1 ? responses.shift()! : responses[0]!);
  const reader: ShopifyWhatsAppConsentReader = { readCurrent };
  return {
    instance: new ShopifyWhatsAppConsentService(reader, db, () => new Date("2026-10-22T12:00:00Z"), { info: vi.fn(), warn: vi.fn() }),
    readCurrent,
  };
}

const checkout = { shopId: "shop-a", customerId: "customer-a", shopifyCustomerId: "12345", recipient: "+44 7400 123456" };

beforeEach(() => vi.clearAllMocks());

describe("ShopifyWhatsAppConsentService", () => {
  it("verifies one new checkout and projects its exact phone; later sends consult only the stored revisions", async () => {
    const ctx = fakeDatabase();
    const { instance, readCurrent } = service(ctx.db);
    expect(await instance.evaluateRecipient(checkout)).toEqual({
      status: "ALLOWED", customerPhoneId: "phone-a", canonicalRecipient: "447400123456",
      consentRevision: 1n, noContactRevision: 0n,
    });
    expect(ctx.phones[0]).toMatchObject({
      whatsappCanonicalPhone: "447400123456", whatsappConsentDecision: "GRANTED",
      whatsappConsentSource: "SHOPIFY_NATIVE", whatsappConsentRevision: 1n,
      whatsappConsentDecisionSequence: 1n,
    });
    expect(await instance.evaluateStoredRecipient({ shopId: "shop-a", customerId: "customer-a", recipient: checkout.recipient }))
      .toMatchObject({ status: "ALLOWED", consentRevision: 1n });
    expect(readCurrent).toHaveBeenCalledTimes(1);
    expect(readCurrent).toHaveBeenCalledWith({ shopDomain: "a-shop.myshopify.com", customerGid: GID });
  });

  it("keeps identical Shopify events idempotent and drops out-of-order grants after revocation", async () => {
    const ctx = fakeDatabase();
    const { instance } = service(ctx.db, [SUBSCRIBED, SUBSCRIBED, REVOKED, SUBSCRIBED]);
    expect((await instance.syncCustomer({ shopId: "shop-a", shopifyCustomerId: GID })).status).toBe("UPDATED");
    expect((await instance.syncCustomer({ shopId: "shop-a", shopifyCustomerId: "12345" })).status).toBe("UNCHANGED");
    expect((await instance.syncCustomer({ shopId: "shop-a", shopifyCustomerId: GID })).status).toBe("UPDATED");
    expect((await instance.syncCustomer({ shopId: "shop-a", shopifyCustomerId: GID })).status).toBe("UNAVAILABLE");
    expect(ctx.phones[0]).toMatchObject({ whatsappConsentDecision: "REVOKED", whatsappConsentRevision: 2n });
    expect((await instance.evaluateStoredRecipient({ shopId: "shop-a", customerId: "customer-a", recipient: checkout.recipient })).status)
      .toBe("NOT_AUTHORISED");
  });

  it("records a Shopify subscribed observation after STOP without clearing local no-contact", async () => {
    const ctx = fakeDatabase();
    ctx.phones[0]!.whatsappNoContact = true;
    ctx.phones[0]!.whatsappNoContactReason = "CUSTOMER_STOP";
    ctx.phones[0]!.whatsappNoContactRevision = 8n;
    ctx.phones[0]!.whatsappNoContactAt = new Date("2026-10-21T08:00:00Z");
    const { instance } = service(ctx.db);
    expect(await instance.evaluateRecipient(checkout)).toEqual({ status: "NOT_AUTHORISED", reason: "LOCAL_NO_CONTACT" });
    expect(ctx.phones[0]).toMatchObject({ whatsappConsentDecision: "GRANTED", whatsappNoContact: true,
      whatsappNoContactReason: "CUSTOMER_STOP", whatsappNoContactRevision: 8n });
  });

  it("respects a STOP written concurrently with a native consent projection", async () => {
    const ctx = fakeDatabase();
    ctx.raceWith(() => {
      ctx.phones[0]!.whatsappNoContact = true;
      ctx.phones[0]!.whatsappNoContactReason = "CUSTOMER_STOP";
      ctx.phones[0]!.whatsappNoContactRevision = 1n;
      ctx.phones[0]!.whatsappNoContactAt = new Date();
    });
    const { instance } = service(ctx.db);
    expect((await instance.evaluateRecipient(checkout)).status).toBe("NOT_AUTHORISED");
    expect(ctx.phones[0]!.whatsappConsentDecision).toBe("GRANTED");
    expect(ctx.phones[0]!.whatsappNoContactRevision).toBe(1n);
  });

  it("revokes the old recipient's permission on a changed Shopify default phone", async () => {
    const ctx = fakeDatabase();
    const { instance } = service(ctx.db, [SUBSCRIBED, { ...REVOKED, state: "SUBSCRIBED", phoneNumber: "+447400123457" }]);
    expect((await instance.evaluateRecipient(checkout)).status).toBe("ALLOWED");
    expect(await instance.evaluateRecipient(checkout)).toMatchObject({
      status: "NOT_AUTHORISED", reason: "SHOPIFY_DEFAULT_PHONE_CHANGED",
    });
    expect(ctx.phones[0]!.whatsappConsentDecision).toBe("UNKNOWN");
    expect((await instance.evaluateStoredRecipient({ shopId: "shop-a", customerId: "customer-a", recipient: checkout.recipient })).status)
      .toBe("NOT_AUTHORISED");
    expect(ctx.mocks.customer.create).not.toHaveBeenCalled();
  });

  it("rejects legacy duplicate phones even when presentation differs", async () => {
    const ctx = fakeDatabase();
    ctx.customers.push({ id: "other-shopify", shopId: "shop-a", shopifyCustomerId: "789" });
    ctx.phones.push(phone("other-phone", "other-shopify", "+44 (7400) 123456"));
    const { instance, readCurrent } = service(ctx.db);
    expect((await instance.evaluateRecipient(checkout)).status).toBe("AMBIGUOUS");
    expect(readCurrent).not.toHaveBeenCalled();
  });

  it("does not grant on provider failure, missing default phone or wrong customer GID", async () => {
    for (const outcome of [
      { kind: "UNAVAILABLE", reason: "ACCESS_DENIED" } as const,
      { kind: "NOT_FOUND" } as const,
      { ...SUBSCRIBED, customerGid: "gid://shopify/Customer/99999" },
    ]) {
      const ctx = fakeDatabase();
      const { instance } = service(ctx.db, outcome);
      expect((await instance.evaluateRecipient(checkout)).status).not.toBe("ALLOWED");
      expect(ctx.phones[0]!.whatsappConsentDecision).not.toBe("GRANTED");
    }
  });

  it("does not infer customer identity from legacy phone-only rows", async () => {
    const ctx = fakeDatabase();
    ctx.phones.push(phone("legacy-phone", "legacy"));
    const { instance, readCurrent } = service(ctx.db);
    expect(await instance.evaluateRecipient({ ...checkout, customerId: "legacy" })).toEqual({
      status: "NOT_AUTHORISED", reason: "CUSTOMER_IDENTITY_NOT_LINKED",
    });
    expect(readCurrent).not.toHaveBeenCalled();
    expect(ctx.mocks.customer.update).not.toHaveBeenCalled();
    expect(ctx.mocks.customer.create).not.toHaveBeenCalled();
  });

  it("does not merge two Customers with the same numeric vs GID Shopify ID", async () => {
    const ctx = fakeDatabase();
    ctx.customers.push({ id: "duplicate", shopId: "shop-a", shopifyCustomerId: GID });
    const { instance, readCurrent } = service(ctx.db);
    expect((await instance.syncCustomer({ shopId: "shop-a", shopifyCustomerId: GID })).status).toBe("AMBIGUOUS");
    expect(readCurrent).not.toHaveBeenCalled();
  });

  it("rejects ambiguous shared recipients within a shop but scopes identical numbers in another shop", async () => {
    const ctx = fakeDatabase();
    const { instance } = service(ctx.db);
    expect((await instance.syncCustomer({ shopId: "shop-a", shopifyCustomerId: GID })).status).toBe("UPDATED");
    expect(ctx.phones[1]!.whatsappConsentRevision).toBe(0n);
    ctx.customers.push({ id: "another", shopId: "shop-a", shopifyCustomerId: "789" });
    const duplicate = phone("another-phone", "another");
    duplicate.whatsappCanonicalPhone = "447400123456";
    ctx.phones.push(duplicate);
    expect((await instance.evaluateStoredRecipient({ shopId: "shop-a", customerId: "customer-a", recipient: checkout.recipient })).status)
      .toBe("AMBIGUOUS");
  });

  it("requires a valid, shop-owned identity for stored sends, without a Shopify read", async () => {
    const ctx = fakeDatabase();
    const { instance, readCurrent } = service(ctx.db);
    expect((await instance.evaluateStoredRecipient({ shopId: "shop-b", customerId: "customer-a", recipient: checkout.recipient })).status)
      .toBe("NOT_AUTHORISED");
    expect((await instance.evaluateStoredRecipient({ shopId: "shop-a", customerId: "legacy", recipient: checkout.recipient })).status)
      .toBe("NOT_AUTHORISED");
    expect(readCurrent).not.toHaveBeenCalled();
  });

  it("does not re-authorise under PENDING, NEVER_SUBSCRIBED or REDACTED", async () => {
    for (const state of ["PENDING", "NEVER_SUBSCRIBED", "REDACTED"] as const) {
      const ctx = fakeDatabase();
      const { instance } = service(ctx.db, { ...SUBSCRIBED, state });
      expect((await instance.evaluateRecipient(checkout)).status).toBe("NOT_AUTHORISED");
      expect(ctx.phones[0]!.whatsappConsentDecision).toBe("UNKNOWN");
    }
  });
});
