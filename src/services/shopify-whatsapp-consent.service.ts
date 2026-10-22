import type { CustomerPhone, PrismaClient, Shop } from "@prisma/client";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import {
  normalizeRecipientPhone,
  parseShopifyCustomerIdentity,
} from "@modainteract/moda-interact-shared/identity";
import prisma from "../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import {
  ShopifyWhatsAppConsentProvider,
  type ShopifyWhatsAppConsentObservation,
  type ShopifyWhatsAppConsentReader,
} from "../providers/shopify-whatsapp-consent.provider.js";

export type ShopifyWhatsAppConsentEligibility =
  | {
      status: "ALLOWED";
      customerPhoneId: string;
      canonicalRecipient: string;
      consentRevision: bigint;
      noContactRevision: bigint;
    }
  | { status: "NOT_AUTHORISED"; reason: string }
  | { status: "UNAVAILABLE"; reason: string }
  | { status: "AMBIGUOUS"; reason: string };

export type ShopifyWhatsAppConsentSyncResult =
  | { status: "UPDATED" | "UNCHANGED"; customerPhoneId: string }
  | { status: "NOT_AUTHORISED" | "UNAVAILABLE" | "AMBIGUOUS"; reason: string };

export interface ShopifyWhatsAppConsentServicePort {
  syncCustomer(input: { shopId: string; shopifyCustomerId: string }): Promise<ShopifyWhatsAppConsentSyncResult>;
  evaluateRecipient(input: {
    shopId: string;
    customerId: string;
    shopifyCustomerId: string;
    recipient: string;
  }): Promise<ShopifyWhatsAppConsentEligibility>;
  evaluateStoredRecipient(input: {
    shopId: string;
    customerId: string;
    recipient: string;
  }): Promise<ShopifyWhatsAppConsentEligibility>;
}

type Failure = Extract<ShopifyWhatsAppConsentEligibility, { status: "NOT_AUTHORISED" | "UNAVAILABLE" | "AMBIGUOUS" }>;
type Identity = ReturnType<typeof parseShopifyCustomerIdentity>;
type ScopedCustomer = {
  shop: Pick<Shop, "id" | "domain" | "defaultCountryCode">;
  customerId: string;
  identity: Identity;
};
type ScopedResult = { ok: true; value: ScopedCustomer } | { ok: false; failure: Failure };
type RecipientResult =
  | { ok: true; phone: CustomerPhone; canonical: string }
  | { ok: false; failure: Failure };
type RefreshResult = ShopifyWhatsAppConsentSyncResult;
type InvalidationResult = {
  failure: Failure | null;
  hasNewerDisplacedObservation: boolean;
};

const defaultLogger = createLogger({
  serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName(),
});

const notAuthorised = (reason: string): Failure => ({ status: "NOT_AUTHORISED", reason });
const unavailable = (reason: string): Failure => ({ status: "UNAVAILABLE", reason });
const ambiguous = (reason: string): Failure => ({ status: "AMBIGUOUS", reason });

/**
 * The sole Background owner of the Shopify-native CustomerPhone projection.
 * A live read happens BEFORE any writes. All writes are optimistic single-row
 * Prisma updates, so a concurrent STOP never loses its independent state.
 */
export class ShopifyWhatsAppConsentService implements ShopifyWhatsAppConsentServicePort {
  constructor(
    private readonly reader: ShopifyWhatsAppConsentReader = new ShopifyWhatsAppConsentProvider(),
    private readonly database: PrismaClient = prisma,
    private readonly now: () => Date = () => new Date(),
    private readonly logger: Pick<StructuredLogger, "warn" | "info"> = defaultLogger,
  ) {}

  async syncCustomer(input: {
    shopId: string;
    shopifyCustomerId: string;
  }): Promise<ShopifyWhatsAppConsentSyncResult> {
    const scoped = await this.resolveCustomer(input.shopId, input.shopifyCustomerId);
    if (!scoped.ok) return scoped.failure;
    return this.refresh(scoped.value);
  }

  async evaluateRecipient(input: {
    shopId: string;
    customerId: string;
    shopifyCustomerId: string;
    recipient: string;
  }): Promise<ShopifyWhatsAppConsentEligibility> {
    const scoped = await this.resolveCustomer(input.shopId, input.shopifyCustomerId, input.customerId);
    if (!scoped.ok) return scoped.failure;
    const expected = await this.findRecipient(scoped.value, input.recipient);
    if (!expected.ok) return expected.failure;

    // Each *new checkout* consumer calls this method once, not on duplicate
    // deliveries. This service deliberately has no checkout-key dedup state.
    const sync = await this.refresh(scoped.value, expected);
    if (sync.status === "NOT_AUTHORISED" || sync.status === "UNAVAILABLE" || sync.status === "AMBIGUOUS") {
      return sync;
    }
    return this.evaluateStoredRecipient({
      shopId: input.shopId,
      customerId: input.customerId,
      recipient: input.recipient,
    });
  }

  async evaluateStoredRecipient(input: {
    shopId: string;
    customerId: string;
    recipient: string;
  }): Promise<ShopifyWhatsAppConsentEligibility> {
    const scoped = await this.resolveCustomerById(input.shopId, input.customerId);
    if (!scoped.ok) return scoped.failure;
    const match = await this.findRecipient(scoped.value, input.recipient);
    if (!match.ok) return match.failure;
    const row = match.phone;
    // Local STOP and merchant suppression override ANY native Shopify state.
    if (row.whatsappNoContact) return notAuthorised("LOCAL_NO_CONTACT");
    if (row.whatsappConsentPurpose !== "WHATSAPP_CHECKOUT_RECOVERY" ||
        row.whatsappConsentDecision !== "GRANTED" ||
        row.whatsappConsentSource !== "SHOPIFY_NATIVE" ||
        !row.whatsappConsentVerifiedAt || !row.whatsappPhoneVerifiedAt ||
        !row.whatsappConsentProviderObservedAt ||
        row.whatsappConsentVerifiedAt < row.whatsappConsentProviderObservedAt ||
        row.whatsappConsentVerifiedAt < row.whatsappPhoneVerifiedAt ||
        row.whatsappConsentRevision <= 0n || row.whatsappConsentDecisionSequence <= 0n ||
        row.whatsappCanonicalPhone !== match.canonical.slice(1)) {
      return notAuthorised("NATIVE_CONSENT_NOT_GRANTED");
    }
    return {
      status: "ALLOWED",
      customerPhoneId: row.id,
      canonicalRecipient: match.canonical.slice(1),
      consentRevision: row.whatsappConsentRevision,
      noContactRevision: row.whatsappNoContactRevision,
    };
  }

  private async resolveCustomer(
    shopId: string,
    shopifyCustomerId: string,
    expectedCustomerId?: string,
  ): Promise<ScopedResult> {
    let identity: Identity;
    try {
      identity = parseShopifyCustomerIdentity(shopifyCustomerId);
    } catch {
      return { ok: false, failure: notAuthorised("UNVERIFIED_SHOPIFY_IDENTITY") };
    }
    const shop = await this.database.shop.findUnique({
      where: { id: shopId },
      select: { id: true, domain: true, platform: true, status: true, defaultCountryCode: true },
    });
    if (!shop || shop.platform !== "SHOPIFY" || shop.status !== "ACTIVE") {
      return { ok: false, failure: notAuthorised("SHOP_NOT_ELIGIBLE") };
    }
    // Numeric and GraphQL GID are accepted ONLY when already linked to an
    // existing shop-owned Customer. Never merge a phone-only legacy Customer.
    const customers = await this.database.customer.findMany({
      where: { shopId, shopifyCustomerId: { in: [identity.numericId, identity.gid] } },
      select: { id: true },
      take: 2,
    });
    if (customers.length > 1) return { ok: false, failure: ambiguous("DUPLICATE_SHOPIFY_IDENTITY") };
    const customer = customers[0];
    if (!customer || (expectedCustomerId !== undefined && customer.id !== expectedCustomerId)) {
      return { ok: false, failure: notAuthorised("CUSTOMER_IDENTITY_NOT_LINKED") };
    }
    return { ok: true, value: { shop, customerId: customer.id, identity } };
  }

  private async resolveCustomerById(shopId: string, customerId: string): Promise<ScopedResult> {
    const customer = await this.database.customer.findFirst({
      where: { id: customerId, shopId },
      select: { shopifyCustomerId: true },
    });
    if (!customer?.shopifyCustomerId) {
      return { ok: false, failure: notAuthorised("CUSTOMER_IDENTITY_NOT_LINKED") };
    }
    return this.resolveCustomer(shopId, customer.shopifyCustomerId, customerId);
  }

  private canonical(phone: string, shop: ScopedCustomer["shop"]): string | null {
    // Never derive a national prefix from a language tag or locale.
    const country = shop.defaultCountryCode?.toUpperCase();
    const context = phone.trim().startsWith("+") ? {} :
      country ? { verifiedCountryCode: country } : {};
    const normalized = normalizeRecipientPhone(phone, context);
    return normalized.ok ? normalized.e164 : null;
  }

  private async findRecipient(scoped: ScopedCustomer, recipient: string): Promise<RecipientResult> {
    const canonical = this.canonical(recipient, scoped.shop);
    if (!canonical) return { ok: false, failure: notAuthorised("INVALID_RECIPIENT") };
    const phones = await this.database.customerPhone.findMany({
      where: { customerId: scoped.customerId, endedAt: null, customer: { shopId: scoped.shop.id } },
    });
    const matching = phones.filter((phone) =>
      this.canonical(phone.phone, scoped.shop) === canonical &&
      (phone.whatsappCanonicalPhone === null || phone.whatsappCanonicalPhone === canonical.slice(1)));
    if (matching.length === 0) return { ok: false, failure: notAuthorised("ACTIVE_RECIPIENT_NOT_FOUND") };
    if (matching.length !== 1) return { ok: false, failure: ambiguous("MULTIPLE_ACTIVE_RECIPIENTS") };
    const phone = matching[0]!;
    // Do not treat another customer with the same recipient as the verified
    // principal, even if the Shopify customer ID uniquely identifies this one.
    const others = await this.database.customerPhone.findMany({
      where: {
        endedAt: null,
        customer: { shopId: scoped.shop.id },
        OR: [
          { whatsappCanonicalPhone: canonical.slice(1) },
          { phone: { in: [phone.phone, recipient, canonical] } },
        ],
      },
      select: { id: true },
      take: 2,
    });
    if (others.some((other) => other.id !== phone.id)) {
      return { ok: false, failure: ambiguous("RECIPIENT_SHARED_BY_CUSTOMERS") };
    }
    // Pre-migration legacy phones have no canonical index key. Do not silently
    // authorise a number shared in another presentation format. Bound the scan
    // and fail closed if the merchant has too many unverified legacy numbers;
    // a subsequent canonical backfill can remove this legacy ambiguity.
    const unverified = await this.database.customerPhone.findMany({
      where: { endedAt: null, whatsappCanonicalPhone: null, customer: { shopId: scoped.shop.id } },
      select: { id: true, phone: true },
      take: 251,
    });
    if (unverified.length > 250) {
      return { ok: false, failure: ambiguous("UNVERIFIED_LEGACY_RECIPIENTS") };
    }
    if (unverified.some((other) => other.id !== phone.id &&
        this.canonical(other.phone, scoped.shop) === canonical)) {
      return { ok: false, failure: ambiguous("RECIPIENT_SHARED_BY_CUSTOMERS") };
    }
    return { ok: true, phone, canonical };
  }

  private async refresh(scoped: ScopedCustomer, expected?: { phone: CustomerPhone; canonical: string }): Promise<RefreshResult> {
    const startedAt = this.now();
    let observation: ShopifyWhatsAppConsentObservation;
    try {
      observation = await this.reader.readCurrent({
        shopDomain: scoped.shop.domain,
        customerGid: scoped.identity.gid,
      });
    } catch {
      this.logger.warn("shopify.whatsapp_consent.read", { shopId: scoped.shop.id, outcome: "unavailable", reasonCode: "SHOPIFY_READ_FAILURE" });
      return unavailable("SHOPIFY_READ_FAILURE");
    }
    if (observation.kind === "UNAVAILABLE") {
      this.logger.warn("shopify.whatsapp_consent.read", { shopId: scoped.shop.id, outcome: "unavailable", reasonCode: observation.reason });
      return unavailable(`SHOPIFY_${observation.reason}`);
    }

    if (observation.kind === "NOT_FOUND") {
      // Shopify no longer has the linked customer/default number. Invalidate
      // any old Shopify grant for that Customer; never transfer it by phone.
      const invalidated = await this.invalidateOtherNumbers(scoped, null, startedAt);
      if (invalidated.failure) return invalidated.failure;
      return notAuthorised("SHOPIFY_CUSTOMER_OR_PHONE_NOT_FOUND");
    }
    if (observation.customerGid !== scoped.identity.gid) {
      return unavailable("SHOPIFY_IDENTITY_MISMATCH");
    }
    const providerCanonical = this.canonical(observation.phoneNumber, scoped.shop);
    if (!providerCanonical) return unavailable("INVALID_SHOPIFY_PHONE");

    const updatedAt = observation.updatedAt === null ? startedAt : new Date(observation.updatedAt);
    const verifiedAt = this.now();
    if (!Number.isFinite(updatedAt.getTime()) || updatedAt.getTime() > verifiedAt.getTime()) {
      return unavailable("INVALID_SHOPIFY_OBSERVATION_TIME");
    }
    const invalidated = await this.invalidateOtherNumbers(scoped, providerCanonical, updatedAt);
    if (invalidated.failure) return invalidated.failure;
    if (expected && expected.canonical !== providerCanonical) {
      return notAuthorised("SHOPIFY_DEFAULT_PHONE_CHANGED");
    }
    // A consent updatedAt is not the time Shopify's *default phone* changed.
    // A displaced phone may have a newer consent observation even though the
    // current default is different. Invalidate its grant, but never use the
    // older observation to grant the newly reported number.
    if (invalidated.hasNewerDisplacedObservation) {
      return unavailable("STALE_OR_CONFLICTING_OBSERVATION");
    }
    const match = await this.findRecipient(scoped, observation.phoneNumber);
    if (!match.ok) return match.failure;
    if (expected && expected.phone.id !== match.phone.id) {
      return notAuthorised("ACTIVE_RECIPIENT_CHANGED");
    }
    const decision = observation.state === "SUBSCRIBED" ? "GRANTED" :
      observation.state === "UNSUBSCRIBED" ? "REVOKED" : "UNKNOWN";
    return this.persist(scoped, match.phone.id, match.canonical, decision, updatedAt, verifiedAt);
  }

  private async invalidateOtherNumbers(
    scoped: ScopedCustomer,
    authoritativeCanonical: string | null,
    observedAt: Date,
  ): Promise<InvalidationResult> {
    const phones = await this.database.customerPhone.findMany({
      where: {
        customerId: scoped.customerId,
        endedAt: null,
        // The first invalidation withdraws the source without fabricating a
        // later Shopify consent timestamp. Keep its retained observedAt as an
        // ordering fence on retries, even after the native source is cleared.
        OR: [
          { whatsappConsentSource: "SHOPIFY_NATIVE" },
          { whatsappConsentSource: null, whatsappConsentProviderObservedAt: { not: null } },
        ],
      },
    });
    let hasNewerDisplacedObservation = false;
    for (const phone of phones) {
      const local = this.canonical(phone.phone, scoped.shop);
      const stillDefault = authoritativeCanonical !== null && local !== null &&
        local === authoritativeCanonical && phone.whatsappCanonicalPhone === local.slice(1);
      if (stillDefault) continue;
      if (phone.whatsappConsentProviderObservedAt &&
          phone.whatsappConsentProviderObservedAt >= observedAt) {
        hasNewerDisplacedObservation = true;
      }
      if (phone.whatsappConsentDecision !== "GRANTED") continue;
      const failure = await this.invalidateDisplacedGrant(scoped, phone.id, authoritativeCanonical);
      if (failure) return { failure, hasNewerDisplacedObservation };
    }
    return { failure: null, hasNewerDisplacedObservation };
  }

  /**
   * A changed Shopify default phone invalidates the previous recipient even
   * when the new default's consent updatedAt predates the old grant. This is
   * a recipient-identity invalidation, NOT a new provider consent observation:
   * retain the stored observedAt/verification evidence and only withdraw the
   * grant under a native-consent CAS. Clearing the source records that this
   * withdrawal is NOT a new Shopify observation; the Database trigger requires
   * a strictly later provider timestamp for any decision change retaining a
   * non-null source. A concurrent STOP remains untouched.
   */
  private async invalidateDisplacedGrant(
    scoped: ScopedCustomer,
    phoneId: string,
    authoritativeCanonical: string | null,
  ): Promise<Failure | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const phone = await this.database.customerPhone.findFirst({
        where: {
          id: phoneId,
          customerId: scoped.customerId,
          endedAt: null,
          customer: {
            shopId: scoped.shop.id,
            shopifyCustomerId: { in: [scoped.identity.numericId, scoped.identity.gid] },
            shop: { platform: "SHOPIFY", status: "ACTIVE" },
          },
        },
      });
      if (!phone) return notAuthorised("ACTIVE_RECIPIENT_CHANGED");
      if (phone.whatsappConsentSource !== "SHOPIFY_NATIVE" || phone.whatsappConsentDecision !== "GRANTED") {
        return null;
      }
      const local = this.canonical(phone.phone, scoped.shop);
      if (authoritativeCanonical !== null && local !== null &&
          local === authoritativeCanonical && phone.whatsappCanonicalPhone === local.slice(1)) {
        return null;
      }
      try {
        const updated = await this.database.customerPhone.updateMany({
          where: {
            id: phone.id,
            customerId: scoped.customerId,
            endedAt: null,
            phone: phone.phone,
            whatsappCanonicalPhone: phone.whatsappCanonicalPhone,
            whatsappConsentSource: "SHOPIFY_NATIVE",
            whatsappConsentDecision: "GRANTED",
            whatsappConsentRevision: phone.whatsappConsentRevision,
            whatsappConsentDecisionSequence: phone.whatsappConsentDecisionSequence,
            whatsappConsentProviderObservedAt: phone.whatsappConsentProviderObservedAt,
            customer: {
              shopId: scoped.shop.id,
              shopifyCustomerId: { in: [scoped.identity.numericId, scoped.identity.gid] },
              shop: { platform: "SHOPIFY", status: "ACTIVE" },
            },
          },
          data: {
            whatsappConsentDecision: "UNKNOWN",
            whatsappConsentSource: null,
            whatsappConsentRevision: { increment: 1 },
            whatsappConsentDecisionSequence: { increment: 1 },
          },
        });
        if (updated.count === 1) {
          this.logger.info("shopify.whatsapp_consent.sync", {
            shopId: scoped.shop.id, outcome: "displaced_recipient_invalidated",
          });
          return null;
        }
      } catch {
        this.logger.warn("shopify.whatsapp_consent.sync", {
          shopId: scoped.shop.id, outcome: "unavailable", reasonCode: "CONSENT_WRITE_FAILURE",
        });
        return unavailable("CONSENT_WRITE_FAILURE");
      }
      // Re-read after any competing native consent update; never overwrite its
      // revision, provider timestamp, or an independently recorded STOP.
    }
    return unavailable("CONCURRENT_CONSENT_UPDATE");
  }

  private async persist(
    scoped: ScopedCustomer,
    phoneId: string,
    canonical: string | null,
    decision: "GRANTED" | "REVOKED" | "UNKNOWN",
    observedAt: Date,
    verifiedAt: Date,
  ): Promise<RefreshResult> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const phone = await this.database.customerPhone.findFirst({
        where: { id: phoneId, customerId: scoped.customerId, endedAt: null, customer: {
          shopId: scoped.shop.id, shopifyCustomerId: { in: [scoped.identity.numericId, scoped.identity.gid] },
          shop: { platform: "SHOPIFY", status: "ACTIVE" },
        } },
      });
      if (!phone) return notAuthorised("ACTIVE_RECIPIENT_CHANGED");
      const actual = this.canonical(phone.phone, scoped.shop);
      if (canonical !== actual) return notAuthorised("ACTIVE_RECIPIENT_CHANGED");
      if (decision === "GRANTED" &&
          (!canonical || (phone.whatsappCanonicalPhone !== null && phone.whatsappCanonicalPhone !== canonical.slice(1)))) {
        return notAuthorised("CANONICAL_RECIPIENT_CHANGED");
      }
      // A later provider observation wins even if its HTTP response arrived first.
      const previous = phone.whatsappConsentProviderObservedAt;
      if (previous && observedAt <= previous) {
        if (previous.getTime() === observedAt.getTime() &&
            phone.whatsappConsentDecision === decision &&
            phone.whatsappConsentSource === "SHOPIFY_NATIVE" &&
            (decision !== "GRANTED" || phone.whatsappCanonicalPhone === canonical?.slice(1))) {
          return { status: "UNCHANGED", customerPhoneId: phone.id };
        }
        return unavailable("STALE_OR_CONFLICTING_OBSERVATION");
      }
      if (decision === "GRANTED" && !canonical) return notAuthorised("INVALID_RECIPIENT");
      // Only write consent-owned fields. In particular, never write the local
      // whatsappNoContact flag/reason/at/revision or its clearance timestamp.
      let updated: { count: number };
      try {
        updated = await this.database.customerPhone.updateMany({
          where: {
            id: phone.id,
            customerId: scoped.customerId,
            endedAt: null,
            phone: phone.phone,
            whatsappCanonicalPhone: phone.whatsappCanonicalPhone,
            whatsappConsentRevision: phone.whatsappConsentRevision,
            whatsappConsentDecisionSequence: phone.whatsappConsentDecisionSequence,
            customer: {
              shopId: scoped.shop.id, shopifyCustomerId: { in: [scoped.identity.numericId, scoped.identity.gid] },
              shop: { platform: "SHOPIFY", status: "ACTIVE" },
            },
          },
          data: {
            whatsappCanonicalPhone: canonical?.slice(1) ?? phone.whatsappCanonicalPhone,
            whatsappPhoneVerifiedAt: canonical ? verifiedAt : phone.whatsappPhoneVerifiedAt,
            whatsappConsentPurpose: "WHATSAPP_CHECKOUT_RECOVERY",
            whatsappConsentDecision: decision,
            whatsappConsentSource: "SHOPIFY_NATIVE",
            whatsappConsentProviderObservedAt: observedAt,
            whatsappConsentVerifiedAt: verifiedAt,
            whatsappConsentRevision: { increment: 1 },
            whatsappConsentDecisionSequence: { increment: 1 },
          },
        });
      } catch {
        // A constraint/permission failure is not proof of consent.
        this.logger.warn("shopify.whatsapp_consent.sync", { shopId: scoped.shop.id, outcome: "unavailable", reasonCode: "CONSENT_WRITE_FAILURE" });
        return unavailable("CONSENT_WRITE_FAILURE");
      }
      if (updated.count === 1) {
        this.logger.info("shopify.whatsapp_consent.sync", { shopId: scoped.shop.id, outcome: "updated", decision });
        return { status: "UPDATED", customerPhoneId: phone.id };
      }
      // A competing STOP or revision may have committed; re-read, never blindly
      // overwrite a newer native observation.
    }
    return unavailable("CONCURRENT_CONSENT_UPDATE");
  }
}
