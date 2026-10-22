import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  WooRecoveryConsentReader,
  type WooRecoveryConsentReadInput,
} from "../../../../src/services/woocommerce-recovery-consent.service.js";

const VERIFIED = new Date("2026-10-22T12:00:00Z");
const E164 = "+447400123456";
const DIGITS = "447400123456";
const context = { kind: "JOB" as const, shopId: "woo-a" };
const request: WooRecoveryConsentReadInput = { context, recipient: E164 };

const permitted = (overrides: Record<string, unknown> = {}) => ({
  id: "phone-a", customerId: "customer-a", phone: E164,
  whatsappCanonicalPhone: DIGITS,
  whatsappPhoneVerifiedAt: VERIFIED,
  whatsappConsentPurpose: "WHATSAPP_CHECKOUT_RECOVERY",
  whatsappConsentDecision: "GRANTED",
  whatsappConsentSource: "WOO_MODA_CHECKBOX",
  whatsappConsentVerifiedAt: VERIFIED,
  whatsappConsentProviderObservedAt: new Date(VERIFIED.getTime() - 1_000),
  whatsappConsentRevision: 2n, whatsappConsentDecisionSequence: 2n,
  whatsappNoContact: false, whatsappNoContactReason: null,
  whatsappNoContactRevision: 0n,
  ...overrides,
});

function reader(phones = [permitted()]) {
  const db = {
    shop: { findUnique: vi.fn(async () => ({
      id: "woo-a", platform: "WOOCOMMERCE", status: "ACTIVE", defaultCountryCode: "GB",
    })) },
    wooCommerceInstallation: { findUnique: vi.fn(async () => ({
      id: "installation-a", status: "ACTIVE", revokedAt: null, credentialVersion: 1,
    })) },
    customerPhone: { findMany: vi.fn(async (_query?: unknown) => phones) },
  };
  return { instance: new WooRecoveryConsentReader(db as unknown as PrismaClient), db };
}

const failure = (result: Awaited<ReturnType<WooRecoveryConsentReader["evaluateRecipient"]>>) =>
  result.status === "ALLOWED" ? null : [result.status, result.reason];

describe("ARCH-046 Woo current recipient consent reader", () => {
  it("reads only the stored Woo marketing grant, returns revisions and verifies a final-send snapshot", async () => {
    const { instance, db } = reader();
    const admitted = await instance.evaluateRecipient(request);
    expect(admitted).toMatchObject({
      status: "ALLOWED", customerPhoneId: "phone-a", canonicalRecipient: DIGITS,
      consentRevision: 2n, noContactRevision: 0n,
      snapshot: { shopId: "woo-a", customerId: "customer-a", installationId: "installation-a",
        credentialVersion: 1, customerPhoneId: "phone-a", consentDecisionSequence: 2n },
    });
    if (admitted.status !== "ALLOWED") throw new Error("Fixture did not grant consent");
    expect((await instance.evaluateRecipient({ ...request, expected: admitted.snapshot })).status).toBe("ALLOWED");
    expect(db.customerPhone.findMany.mock.calls.length).toBe(2);
    expect((await instance.evaluateStoredRecipient({ shopId: "woo-a", customerId: "customer-a",
      recipient: request.recipient, expected: admitted.snapshot })).status).toBe("ALLOWED");
    expect(db.customerPhone.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { customer: { shopId: "woo-a" }, endedAt: null }, take: 251,
    });
    const stale = { ...admitted.snapshot, consentRevision: 1n };
    expect(failure(await instance.evaluateRecipient({ ...request, expected: stale })))
      .toEqual(["NOT_AUTHORISED", "STALE_RECIPIENT_SNAPSHOT"]);
  });

  it("denies missing, duplicated and wrong-customer phone matches", async () => {
    expect(failure(await reader([]).instance.evaluateRecipient(request)))
      .toEqual(["NOT_AUTHORISED", "ACTIVE_RECIPIENT_NOT_FOUND"]);
    expect(failure(await reader([permitted(), permitted({
      id: "phone-b", customerId: "customer-b", whatsappCanonicalPhone: null,
      phone: "07400 123456", whatsappConsentDecision: "UNKNOWN",
    })]).instance.evaluateRecipient(request)))
      .toEqual(["AMBIGUOUS", "RECIPIENT_SHARED_BY_CUSTOMERS"]);
    expect(failure(await reader().instance.evaluateRecipient({ ...request, expectedCustomerId: "customer-b" })))
      .toEqual(["NOT_AUTHORISED", "CUSTOMER_IDENTITY_CHANGED"]);
    expect(failure(await reader([permitted({ phone: "+447400123457" })]).instance.evaluateRecipient(request)))
      .toEqual(["NOT_AUTHORISED", "ACTIVE_RECIPIENT_CHANGED"]);
  });

  it("refuses too many unverified legacy rows rather than silently accepting one indexed match", async () => {
    const rows = [permitted(), ...Array.from({ length: 250 }, (_, i) => permitted({
      id: `legacy-${i}`, phone: "+14155552671", whatsappCanonicalPhone: null,
    }))];
    expect(failure(await reader(rows).instance.evaluateRecipient(request)))
      .toEqual(["AMBIGUOUS", "UNVERIFIED_LEGACY_RECIPIENTS"]);
  });

  it.each([
    ["no affirmative checkbox", { whatsappConsentDecision: "UNKNOWN" }],
    ["withdrawn consent", { whatsappConsentDecision: "REVOKED" }],
    ["shopify-native consent", { whatsappConsentSource: "SHOPIFY_NATIVE" }],
    ["missing verified phone", { whatsappPhoneVerifiedAt: null }],
    ["missing observation", { whatsappConsentProviderObservedAt: null }],
    ["stale verification", { whatsappConsentVerifiedAt: new Date("2026-10-22T11:58:00Z") }],
    ["unversioned consent", { whatsappConsentRevision: 0n }],
    ["unsequenced consent", { whatsappConsentDecisionSequence: 0n }],
    ["wrong purpose", { whatsappConsentPurpose: "OTHER" }],
  ])("does not treat %s as verified WhatsApp abandoned-basket marketing consent", async (_title, changes) => {
    expect(failure(await reader([permitted(changes)]).instance.evaluateRecipient(request)))
      .toEqual(["NOT_AUTHORISED", "WOO_MARKETING_CONSENT_NOT_GRANTED"]);
  });

  it.each([
    ["CUSTOMER_STOP", { whatsappNoContact: true, whatsappNoContactReason: "CUSTOMER_STOP", whatsappNoContactRevision: 2n }],
    ["MERCHANT_OPT_OUT", { whatsappNoContact: true, whatsappNoContactReason: "MERCHANT_OPT_OUT", whatsappNoContactRevision: 1n }],
    ["corrupt local state", { whatsappNoContact: false, whatsappNoContactReason: "CUSTOMER_STOP" }],
  ])("never lets a checkbox override %s", async (_title, changes) => {
    expect(failure(await reader([permitted(changes)]).instance.evaluateRecipient(request)))
      .toEqual(["NOT_AUTHORISED", "LOCAL_NO_CONTACT"]);
  });

  it("denies disconnected, revoked, wrong-platform or suspended Woo installations", async () => {
    const { instance, db } = reader();
    db.wooCommerceInstallation.findUnique.mockResolvedValueOnce({
      id: "installation-a", status: "REVOKED", revokedAt: VERIFIED, credentialVersion: 1,
    });
    expect(failure(await instance.evaluateRecipient(request)))
      .toEqual(["NOT_AUTHORISED", "WOO_INSTALLATION_INACTIVE"]);
    db.shop.findUnique.mockResolvedValueOnce({
      id: "woo-a", platform: "SHOPIFY", status: "ACTIVE", defaultCountryCode: "GB",
    });
    expect(failure(await instance.evaluateRecipient(request)))
      .toEqual(["NOT_AUTHORISED", "WOO_SHOP_INACTIVE"]);
    db.shop.findUnique.mockResolvedValueOnce({
      id: "woo-a", platform: "WOOCOMMERCE", status: "SUSPENDED", defaultCountryCode: "GB",
    });
    expect(failure(await instance.evaluateRecipient(request)))
      .toEqual(["NOT_AUTHORISED", "WOO_SHOP_INACTIVE"]);
  });

  it("enforces the authenticated installation and detects reconnect/credential rotation", async () => {
    const { instance, db } = reader();
    const installation = { kind: "INSTALLATION" as const, shopId: "woo-a",
      installationId: "installation-a", credentialVersion: 1 };
    const first = await instance.evaluateRecipient({ ...request, context: installation });
    expect(first.status).toBe("ALLOWED");
    db.wooCommerceInstallation.findUnique.mockResolvedValueOnce({
      id: "installation-a", status: "ACTIVE", revokedAt: null, credentialVersion: 2,
    });
    expect(failure(await instance.evaluateRecipient({ ...request, context: installation })))
      .toEqual(["NOT_AUTHORISED", "WOO_INSTALLATION_CHANGED"]);
    if (first.status !== "ALLOWED") return;
    db.wooCommerceInstallation.findUnique.mockResolvedValueOnce({
      id: "installation-b", status: "ACTIVE", revokedAt: null, credentialVersion: 1,
    });
    expect(failure(await instance.evaluateRecipient({ ...request, expected: first.snapshot })))
      .toEqual(["NOT_AUTHORISED", "STALE_RECIPIENT_SNAPSHOT"]);
  });

  it("uses only persisted country context for national numbers; never guesses a locale", async () => {
    const { instance, db } = reader();
    expect((await instance.evaluateRecipient({ ...request, recipient: "07400 123456" })).status)
      .toBe("ALLOWED");
    db.shop.findUnique.mockResolvedValueOnce({
      id: "woo-a", platform: "WOOCOMMERCE", status: "ACTIVE", defaultCountryCode: null,
    });
    expect(failure(await instance.evaluateRecipient({ ...request, recipient: "07400 123456" })))
      .toEqual(["NOT_AUTHORISED", "INVALID_RECIPIENT_COUNTRY_REQUIRED"]);
    expect(failure(await instance.evaluateRecipient({ ...request, recipient: "07400 123456;ext=9" })))
      .toEqual(["NOT_AUTHORISED", "INVALID_RECIPIENT_EXTENSION_UNSUPPORTED"]);
  });

  it("returns UNAVAILABLE on any failed shop, installation or phone read, without revealing the error", async () => {
    const { instance, db } = reader();
    db.shop.findUnique.mockRejectedValueOnce(new Error("PII SECRET SHOP ERROR"));
    expect(failure(await instance.evaluateRecipient(request))).toEqual(["UNAVAILABLE", "CONSENT_READ_FAILED"]);
    db.wooCommerceInstallation.findUnique.mockRejectedValueOnce(new Error("private token"));
    expect(failure(await instance.evaluateRecipient(request))).toEqual(["UNAVAILABLE", "CONSENT_READ_FAILED"]);
    db.customerPhone.findMany.mockRejectedValueOnce(new Error("customer phone"));
    expect(failure(await instance.evaluateRecipient(request))).toEqual(["UNAVAILABLE", "CONSENT_READ_FAILED"]);
  });
});
