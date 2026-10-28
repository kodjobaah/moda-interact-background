import type { PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { ShopifyConsentRecipientResolver } from "./recipient.js";
import { notAuthorised, unavailable, type Failure, type ScopedCustomer, type InvalidationResult, type RefreshResult } from "./types.js";

/** Persists native consent with revision CAS, leaving local STOP state untouched. */
export class ShopifyConsentProjectionWriter {
  constructor(
    private readonly database: PrismaClient,
    private readonly recipient: ShopifyConsentRecipientResolver,
    private readonly logger: Pick<StructuredLogger, "warn" | "info">,
  ) {}

  async invalidateOtherNumbers(
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
      const local = this.recipient.canonical(phone.phone, scoped.shop);
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
      const local = this.recipient.canonical(phone.phone, scoped.shop);
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
      } catch (error) {
        this.logger.warn("shopify.whatsapp_consent.sync", {
          shopId: scoped.shop.id, outcome: "unavailable", reasonCode: "CONSENT_WRITE_FAILURE",
          errorMessage: error instanceof Error ? error.message : String(error), error,
        });
        return unavailable("CONSENT_WRITE_FAILURE");
      }
      // Re-read after any competing native consent update; never overwrite its
      // revision, provider timestamp, or an independently recorded STOP.
    }
    return unavailable("CONCURRENT_CONSENT_UPDATE");
  }

  async persist(
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
      const actual = this.recipient.canonical(phone.phone, scoped.shop);
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
      } catch (error) {
        // A constraint/permission failure is not proof of consent.
        this.logger.warn("shopify.whatsapp_consent.sync", {
          shopId: scoped.shop.id, outcome: "unavailable", reasonCode: "CONSENT_WRITE_FAILURE",
          errorMessage: error instanceof Error ? error.message : String(error), error,
        });
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
