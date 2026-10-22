import type { PrismaClient } from "@prisma/client";
import { normalizeRecipientPhone } from "@modainteract/moda-interact-shared/identity";
import prisma from "../lib/db.js";

/**
 * Only authenticated Woo installation handlers or internal, approved Background
 * jobs may construct this context. It is NOT a public request contract.
 */
export type WooRecoveryConsentContext =
  | { kind: "INSTALLATION"; shopId: string; installationId: string; credentialVersion: number }
  | { kind: "JOB"; shopId: string };

/** A read-time fence, not a lasting grant. Re-evaluate before every outbound send. */
export type WooRecoveryConsentSnapshot = Readonly<{
  shopId: string;
  installationId: string;
  credentialVersion: number;
  customerId: string;
  customerPhoneId: string;
  canonicalRecipient: string;
  consentRevision: bigint;
  consentDecisionSequence: bigint;
  noContactRevision: bigint;
}>;

// The common status/recipient/revision fields intentionally match the stored
// Shopify consent eligibility port, without importing Shopify provider logic.
export type WooRecoveryConsentEligibility =
  | { status: "ALLOWED"; customerPhoneId: string; canonicalRecipient: string;
      consentRevision: bigint; noContactRevision: bigint; snapshot: WooRecoveryConsentSnapshot }
  | { status: "NOT_AUTHORISED" | "UNAVAILABLE" | "AMBIGUOUS"; reason: string };

export type WooRecoveryConsentReadInput = Readonly<{
  context: WooRecoveryConsentContext;
  recipient: string;
  /** Prevent a checkout/customer change from inheriting an unrelated grant. */
  expectedCustomerId?: string;
  /** For a final-send fence: a changed decision, recipient or install denies. */
  expected?: WooRecoveryConsentSnapshot;
}>;

export interface WooRecoveryConsentReaderPort {
  evaluateRecipient(input: WooRecoveryConsentReadInput): Promise<WooRecoveryConsentEligibility>;
  /** Stored-recipient method mirrors the Background Shopify fence input shape. */
  evaluateStoredRecipient(input: {
    shopId: string; customerId: string; recipient: string; expected?: WooRecoveryConsentSnapshot;
  }): Promise<WooRecoveryConsentEligibility>;
}

const denied = (reason: string): WooRecoveryConsentEligibility => ({ status: "NOT_AUTHORISED", reason });
const ambiguous = (reason: string): WooRecoveryConsentEligibility => ({ status: "AMBIGUOUS", reason });
const unavailable = (): WooRecoveryConsentEligibility => ({ status: "UNAVAILABLE", reason: "CONSENT_READ_FAILED" });

type ConsentReadDatabase = Pick<PrismaClient, "shop" | "wooCommerceInstallation" | "customerPhone">;
const MAX_LEGACY_SCAN = 250;

/**
 * Read-only Woo consent policy. Evidence history is never consulted: the
 * transactionally maintained CustomerPhone projection is the authority.
 * No Woo/Shopify HTTP call, recovery write, job, billing or queue side effect.
 */
export class WooRecoveryConsentReader implements WooRecoveryConsentReaderPort {
  constructor(private readonly database: ConsentReadDatabase = prisma) {}

  async evaluateStoredRecipient(input: {
    shopId: string; customerId: string; recipient: string; expected?: WooRecoveryConsentSnapshot;
  }): Promise<WooRecoveryConsentEligibility> {
    return this.evaluateRecipient({
      context: { kind: "JOB", shopId: input.shopId },
      expectedCustomerId: input.customerId,
      recipient: input.recipient,
      ...(input.expected ? { expected: input.expected } : {}),
    });
  }

  async evaluateRecipient(input: WooRecoveryConsentReadInput): Promise<WooRecoveryConsentEligibility> {
    const { context, recipient, expectedCustomerId, expected } = input;
    if (!context.shopId || !recipient ||
      (context.kind === "INSTALLATION" && (!context.installationId ||
        !Number.isSafeInteger(context.credentialVersion) || context.credentialVersion < 1))) {
      return denied("INVALID_CONTEXT_OR_RECIPIENT");
    }
    if (expected?.shopId !== undefined && expected.shopId !== context.shopId) {
      return denied("STALE_RECIPIENT_SNAPSHOT");
    }

    try {
      const shop = await this.database.shop.findUnique({
        where: { id: context.shopId },
        select: { id: true, platform: true, status: true, defaultCountryCode: true },
      });
      if (!shop || shop.platform !== "WOOCOMMERCE" || shop.status !== "ACTIVE") {
        return denied("WOO_SHOP_INACTIVE");
      }
      const installation = await this.database.wooCommerceInstallation.findUnique({
        where: { shopId: shop.id },
        select: { id: true, status: true, revokedAt: true, credentialVersion: true },
      });
      if (!installation || installation.status !== "ACTIVE" || installation.revokedAt) {
        return denied("WOO_INSTALLATION_INACTIVE");
      }
      if (context.kind === "INSTALLATION" &&
        (context.installationId !== installation.id || context.credentialVersion !== installation.credentialVersion)) {
        return denied("WOO_INSTALLATION_CHANGED");
      }

      // Country is taken only from the persisted shop's store country, never
      // from an untrusted checkout locale, language, or arbitrary request field.
      const storedCountry = shop.defaultCountryCode?.toUpperCase();
      const canonical = normalizeRecipientPhone(recipient, recipient.trim().startsWith("+")
        ? {} : storedCountry ? { verifiedCountryCode: storedCountry } : {});
      if (!canonical.ok) return denied(`INVALID_RECIPIENT_${canonical.reason}`);
      const digits = canonical.e164.slice(1);

      // The DB has no shop/canonical unique key: one shop may have two Customers
      // owning the same number. Include unindexed legacy rows and direct phone
      // presentations so an old duplicate never silently authorises a send.
      // Bound this scan; if there are too many legacy rows, fail closed.
      const candidates = await this.database.customerPhone.findMany({
        where: {
          endedAt: null,
          customer: { shopId: shop.id },
          OR: [
            { whatsappCanonicalPhone: digits },
            { whatsappCanonicalPhone: null },
            { phone: { in: [canonical.e164, recipient] } },
          ],
        },
        select: {
          id: true, customerId: true, phone: true, whatsappCanonicalPhone: true,
          whatsappPhoneVerifiedAt: true, whatsappConsentPurpose: true,
          whatsappConsentDecision: true, whatsappConsentSource: true,
          whatsappConsentVerifiedAt: true, whatsappConsentProviderObservedAt: true,
          whatsappConsentRevision: true, whatsappConsentDecisionSequence: true,
          whatsappNoContact: true, whatsappNoContactReason: true, whatsappNoContactRevision: true,
        },
        orderBy: { id: "asc" },
        take: MAX_LEGACY_SCAN + 1,
      });
      if (candidates.length > MAX_LEGACY_SCAN) return ambiguous("UNVERIFIED_LEGACY_RECIPIENTS");

      const matches = candidates.filter((phone) => {
        if (phone.whatsappCanonicalPhone === digits) return true;
        const observed = normalizeRecipientPhone(phone.phone, phone.phone.trim().startsWith("+")
          ? {} : storedCountry ? { verifiedCountryCode: storedCountry } : {});
        return observed.ok && observed.e164 === canonical.e164;
      });
      if (matches.length > 1) return ambiguous("RECIPIENT_SHARED_BY_CUSTOMERS");
      const phone = matches[0];
      if (!phone) return denied("ACTIVE_RECIPIENT_NOT_FOUND");
      if (expectedCustomerId !== undefined && expectedCustomerId !== phone.customerId) {
        return denied("CUSTOMER_IDENTITY_CHANGED");
      }
      if (phone.whatsappCanonicalPhone !== digits) return denied("RECIPIENT_NOT_VERIFIED");
      const currentPhone = normalizeRecipientPhone(phone.phone, phone.phone.trim().startsWith("+")
        ? {} : storedCountry ? { verifiedCountryCode: storedCountry } : {});
      if (!currentPhone.ok || currentPhone.e164 !== canonical.e164) {
        return denied("ACTIVE_RECIPIENT_CHANGED");
      }
      // STOP takes precedence even if a newer Woo checkbox grants permission;
      // the merchant's local opt-out is an independent negative restriction.
      if (phone.whatsappNoContact || phone.whatsappNoContactReason !== null) {
        return denied("LOCAL_NO_CONTACT");
      }
      if (phone.whatsappConsentPurpose !== "WHATSAPP_CHECKOUT_RECOVERY" ||
        phone.whatsappConsentDecision !== "GRANTED" ||
        phone.whatsappConsentSource !== "WOO_MODA_CHECKBOX" ||
        phone.whatsappConsentRevision <= 0n || phone.whatsappConsentDecisionSequence <= 0n ||
        !phone.whatsappPhoneVerifiedAt || !phone.whatsappConsentVerifiedAt ||
        !phone.whatsappConsentProviderObservedAt ||
        phone.whatsappConsentVerifiedAt < phone.whatsappPhoneVerifiedAt ||
        phone.whatsappConsentVerifiedAt < phone.whatsappConsentProviderObservedAt) {
        return denied("WOO_MARKETING_CONSENT_NOT_GRANTED");
      }
      const snapshot: WooRecoveryConsentSnapshot = {
        shopId: shop.id,
        installationId: installation.id,
        credentialVersion: installation.credentialVersion,
        customerId: phone.customerId,
        customerPhoneId: phone.id,
        canonicalRecipient: digits,
        consentRevision: phone.whatsappConsentRevision,
        consentDecisionSequence: phone.whatsappConsentDecisionSequence,
        noContactRevision: phone.whatsappNoContactRevision,
      };
      if (expected && (Object.keys(snapshot) as Array<keyof WooRecoveryConsentSnapshot>)
        .some((key) => snapshot[key] !== expected[key])) {
        return denied("STALE_RECIPIENT_SNAPSHOT");
      }
      return { status: "ALLOWED", customerPhoneId: phone.id,
        canonicalRecipient: digits, consentRevision: phone.whatsappConsentRevision,
        noContactRevision: phone.whatsappNoContactRevision, snapshot };
    } catch {
      // Fail closed without exposing phones, customer IDs or raw DB errors.
      return unavailable();
    }
  }
}

export const wooRecoveryConsentReader = new WooRecoveryConsentReader();
