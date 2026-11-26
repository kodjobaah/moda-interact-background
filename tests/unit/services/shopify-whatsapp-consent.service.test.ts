import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecoveryConsentAdmissionService } from "../../../src/services/checkout-recovery/recovery-consent-admission.service.js";
import { ShopifyWhatsAppConsentService } from "../../../src/services/shopify-whatsapp-consent.service.js";
import { isEligibleShopifyPhone } from "../../../src/services/shopify-whatsapp-consent/phone-resolution.js";

type TestPhone = {
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

function phone(id = "phone-a", customerId = "customer-a", number = "+447400123456"): TestPhone {
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

function database() {
  const shops = [
    { id: "shop-a", domain: "a.myshopify.com", platform: "SHOPIFY", status: "ACTIVE", defaultCountryCode: "GB" },
  ];
  const customers = [
    { id: "customer-a", shopId: "shop-a", shopifyCustomerId: "12345" },
    { id: "other-customer", shopId: "shop-a", shopifyCustomerId: "67890" },
  ];
  const phones = [phone(), phone("phone-other", "other-customer", "+447700900456")];
  // Immutable evidence is independent of the current projection. A projection
  // write alone cannot authorise a send under the signed-receipt contract.
  const evidence: Array<Record<string, unknown>> = [];
  const mock = {
    whatsAppConsentEvidence: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        evidence.find(row => Object.entries(where).every(([key, value]) => {
          const stored = row[key];
          return value instanceof Date && stored instanceof Date
            ? stored.getTime() === value.getTime() : stored === value;
        })) ?? null),
    },
    shop: {
      findUnique: vi.fn(async ({ where }: any) => shops.find((shop) => shop.id === where.id) ?? null),
    },
    customer: {
      findMany: vi.fn(async ({ where, take }: any) => customers.filter((customer) =>
        customer.shopId === where.shopId &&
        where.shopifyCustomerId.in.includes(customer.shopifyCustomerId)).slice(0, take)),
      findFirst: vi.fn(async ({ where }: any) =>
        customers.find((customer) => customer.id === where.id && customer.shopId === where.shopId) ?? null),
    },
    customerPhone: {
      findMany: vi.fn(async ({ where, take, select }: any) => {
        const filtered = phones.filter((row) => {
          const owner = customers.find((customer) => customer.id === row.customerId);
          if (where.customer?.shopId && owner?.shopId !== where.customer.shopId) return false;
          if (where.customerId && row.customerId !== where.customerId) return false;
          if (where.endedAt === null && row.endedAt !== null) return false;
          if (where.whatsappCanonicalPhone !== undefined && row.whatsappCanonicalPhone !== where.whatsappCanonicalPhone) return false;
          if (where.OR && !where.OR.some((clause: any) =>
            clause.whatsappCanonicalPhone !== undefined
              ? row.whatsappCanonicalPhone === clause.whatsappCanonicalPhone
              : clause.phone?.in?.includes(row.phone))) return false;
          return true;
        }).slice(0, take ?? Number.POSITIVE_INFINITY);
        return filtered.map((row) => select
          ? Object.fromEntries(Object.keys(select).filter((key) => select[key])
            .map((key) => [key, row[key as keyof TestPhone]]))
          : row);
      }),
      findFirst: vi.fn(async ({ where }: any) => phones.find((row) =>
        row.id === where.id && row.customerId === where.customerId && row.endedAt === null &&
        customers.find((customer) => customer.id === row.customerId)?.shopId === where.customer.shopId) ?? null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = phones.find((candidate) =>
          candidate.id === where.id && candidate.customerId === where.customerId &&
          candidate.endedAt === null && candidate.phone === where.phone &&
          candidate.whatsappCanonicalPhone === where.whatsappCanonicalPhone &&
          candidate.whatsappConsentRevision === where.whatsappConsentRevision &&
          candidate.whatsappConsentDecisionSequence === where.whatsappConsentDecisionSequence &&
          (where.whatsappNoContact === undefined || candidate.whatsappNoContact === where.whatsappNoContact));
        if (!row) return { count: 0 };
        Object.assign(row, data, {
          whatsappConsentRevision: row.whatsappConsentRevision +
            BigInt(data.whatsappConsentRevision.increment),
          whatsappConsentDecisionSequence: row.whatsappConsentDecisionSequence +
            BigInt(data.whatsappConsentDecisionSequence.increment),
        });
        return { count: 1 };
      }),
    },
  };
  function recordGrantEvidence(row: TestPhone) {
    evidence.push({ id: `evidence-${row.id}-${row.whatsappConsentRevision}`, shopId: "shop-a",
      customerId: row.customerId, customerPhoneId: row.id, canonicalPhone: row.whatsappCanonicalPhone,
      installationId: null, decision: "GRANT", phoneConsentRevision: row.whatsappConsentRevision,
      decisionSequence: row.whatsappConsentDecisionSequence, decisionAt: row.whatsappConsentProviderObservedAt });
  }
  return { db: mock as unknown as PrismaClient, phones, mock, recordGrantEvidence, evidence };
}

const grantInput = {
  shopId: "shop-a",
  shopifyCustomerId: "12345",
  recipient: "+44 7400 123456",
};
function createService(db: PrismaClient, readCurrent = vi.fn()) {
  let timestamp = Date.parse("2026-11-18T03:00:00.000Z");
  return {
    instance: new ShopifyWhatsAppConsentService(db, () => {
      timestamp += 1000;
      return new Date(timestamp);
    }, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    readCurrent,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("Shopify checkout consent SQL projection", () => {
  it("does not read native Shopify consent and admits only an already-materialised grant", async () => {
    const ctx = database();
    const readCurrent = vi.fn();
    const { instance } = createService(ctx.db, readCurrent);

    await expect(instance.evaluateRecipient({
      ...grantInput, customerId: "customer-a", recipient: "447400123456",
    })).resolves.toEqual({ status: "NOT_AUTHORISED", reason: "RECIPIENT_NOT_ATTACHED" });
    expect(await instance.materializeExplicitChoice({
      ...grantInput, customerId: "customer-a", decision: "GRANTED",
    })).toEqual({ status: "MATERIALISED_GRANTED" });
    const input = { ...grantInput, customerId: "customer-a", recipient: "447400123456" };
    await expect(instance.evaluateRecipient(input)).resolves.toEqual({
      status: "NOT_AUTHORISED", reason: "CONSENT_NOT_GRANTED_OR_EVIDENCED",
    });
    ctx.recordGrantEvidence(ctx.phones[0]!);
    await expect(instance.evaluateRecipient(input)).resolves.toMatchObject({
      status: "ALLOWED",
      customerPhoneId: "phone-a",
      canonicalRecipient: "447400123456",
      consentRevision: 1n,
    });
    expect(readCurrent).not.toHaveBeenCalled();
    expect(ctx.phones[0]).toMatchObject({
      whatsappCanonicalPhone: "447400123456",
      whatsappConsentPurpose: "WHATSAPP_CHECKOUT_RECOVERY",
      whatsappConsentDecision: "GRANTED",
      whatsappConsentSource: "SHOPIFY_NATIVE",
      whatsappConsentRevision: 1n,
      whatsappConsentDecisionSequence: 1n,
    });
  });

  it("rejects malformed stored canonical phones even when evidence matches", async () => {
    const ctx = database();
    const { instance } = createService(ctx.db);
    await expect(instance.materializeExplicitChoice({
      ...grantInput, customerId: "customer-a", decision: "GRANTED",
    })).resolves.toEqual({ status: "MATERIALISED_GRANTED" });
    const row = ctx.phones[0]!;
    ctx.recordGrantEvidence(row);
    await expect(isEligibleShopifyPhone(ctx.db, "shop-a", row.customerId, row as never)).resolves.toBe(true);
    ctx.mock.whatsAppConsentEvidence.findFirst.mockClear();
    row.whatsappCanonicalPhone = "1234567890123456";
    ctx.recordGrantEvidence(row);
    await expect(isEligibleShopifyPhone(ctx.db, "shop-a", row.customerId, row as never)).resolves.toBe(false);
    expect(ctx.mock.whatsAppConsentEvidence.findFirst).not.toHaveBeenCalled();
  });

  it("applies a recoverable revoke to existing SQL permission and denies proactive eligibility", async () => {
    const ctx = database();
    const { instance } = createService(ctx.db);
    await expect(instance.materializeExplicitChoice({
      ...grantInput, customerId: "customer-a", decision: "GRANTED",
    })).resolves.toEqual({ status: "MATERIALISED_GRANTED" });
    ctx.recordGrantEvidence(ctx.phones[0]!);
    await expect(instance.materializeExplicitChoice({
      ...grantInput, customerId: "customer-a", decision: "REVOKED",
    })).resolves.toEqual({ status: "MATERIALISED_REVOKED" });
    await expect(instance.evaluateStoredRecipient({
      shopId: "shop-a", customerId: "customer-a", recipient: "447400123456",
    })).resolves.toEqual({ status: "NOT_AUTHORISED", reason: "CONSENT_NOT_GRANTED_OR_EVIDENCED" });
    expect(ctx.phones[0]).toMatchObject({
      whatsappConsentDecision: "REVOKED",
      whatsappConsentRevision: 2n,
      whatsappConsentDecisionSequence: 2n,
    });
  });

  it("keeps STOP independent, blocking GRANT while allowing a signed REVOKE to persist", async () => {
    const ctx = database();
    ctx.phones[0]!.whatsappNoContact = true;
    ctx.phones[0]!.whatsappNoContactReason = "CUSTOMER_STOP";
    ctx.phones[0]!.whatsappNoContactRevision = 4n;
    const { instance } = createService(ctx.db);

    await expect(instance.materializeExplicitChoice({
      ...grantInput, customerId: "customer-a", decision: "GRANTED",
    })).resolves.toEqual({ status: "BLOCKED_STOP" });
    await expect(instance.materializeExplicitChoice({
      ...grantInput, customerId: "customer-a", decision: "REVOKED",
    })).resolves.toEqual({ status: "MATERIALISED_REVOKED" });
    expect(ctx.phones[0]).toMatchObject({
      whatsappConsentDecision: "REVOKED",
      whatsappNoContact: true,
      whatsappNoContactReason: "CUSTOMER_STOP",
      whatsappNoContactRevision: 4n,
    });
  });

  it("rejects cross-customer recipient attribution and does not migrate a phone-only identity", async () => {
    const ctx = database();
    const { instance } = createService(ctx.db);
    await expect(instance.materializeExplicitChoice({
      shopId: "shop-a",
      customerId: "customer-a",
      shopifyCustomerId: "67890",
      recipient: "+447400123456",
      decision: "GRANTED",
    })).resolves.toEqual({ status: "DEFER_IDENTITY_OR_RECIPIENT" });
    expect(ctx.phones[0]!.whatsappConsentDecision).toBe("UNKNOWN");
    expect(ctx.mock.customerPhone.updateMany).not.toHaveBeenCalled();
  });

  it("makes the legacy provider sync queue a non-mutating no-op", async () => {
    const ctx = database();
    const { instance, readCurrent } = createService(ctx.db);
    await expect(instance.syncCustomer({
      shopId: "shop-a",
      shopifyCustomerId: "12345",
    })).resolves.toEqual({ status: "NOT_AUTHORISED", reason: "SIGNED_RECEIPT_REQUIRED" });
    expect(readCurrent).not.toHaveBeenCalled();
    expect(ctx.mock.customerPhone.updateMany).not.toHaveBeenCalled();
  });

  it("keeps first admission, reentry and conversation checks SQL-only", async () => {
    const ctx = database();
    const { instance, readCurrent } = createService(ctx.db);
    await expect(instance.materializeExplicitChoice({
      ...grantInput, customerId: "customer-a", decision: "GRANTED",
    })).resolves.toEqual({ status: "MATERIALISED_GRANTED" });
    ctx.recordGrantEvidence(ctx.phones[0]!);
    const notices = { notify: vi.fn(async () => "created" as const) };
    const admission = new RecoveryConsentAdmissionService(instance, notices);
    const input = {
      ...grantInput,
      checkoutToken: "checkout",
      customerId: "customer-a",
      recipient: "447400123456",
    };
    await expect(admission.evaluateFirst(input)).resolves.toBe(true);
    await expect(admission.evaluateReentry(input)).resolves.toBe(true);
    expect(readCurrent).not.toHaveBeenCalled();
    expect(notices.notify).not.toHaveBeenCalled();
    // The old evidence must not authorise a newer phone consent revision.
    ctx.phones[0]!.whatsappConsentRevision += 1n;
    await expect(admission.evaluateReentry(input)).resolves.toBe(false);
    expect(notices.notify).toHaveBeenCalledWith(expect.objectContaining({ reason: "NO_VERIFIED_OPT_IN" }));
  });
});
