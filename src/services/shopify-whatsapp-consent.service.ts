import type { CustomerPhone, PrismaClient } from "@prisma/client";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import prisma from "../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import {
  ShopifyWhatsAppConsentProvider,
  type ShopifyWhatsAppConsentObservation,
  type ShopifyWhatsAppConsentReader,
} from "../providers/shopify-whatsapp-consent.provider.js";
import { ShopifyConsentRecipientResolver } from "./shopify-whatsapp-consent/recipient.js";
import { ShopifyConsentProjectionWriter } from "./shopify-whatsapp-consent/projection-writer.js";
import { notAuthorised, unavailable, type ScopedCustomer, type RefreshResult } from "./shopify-whatsapp-consent/types.js";
import type {
  ShopifyWhatsAppConsentEligibility,
  ShopifyWhatsAppConsentSyncResult,
} from "./shopify-whatsapp-consent/types.js";

export type { ShopifyWhatsAppConsentEligibility, ShopifyWhatsAppConsentSyncResult } from "./shopify-whatsapp-consent/types.js";

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

const defaultLogger = createLogger({
  serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName(),
});

/** Coordinates native Shopify consent reads and the scoped, local database projection. */
export class ShopifyWhatsAppConsentService implements ShopifyWhatsAppConsentServicePort {
  private readonly recipients: ShopifyConsentRecipientResolver;
  private readonly writes: ShopifyConsentProjectionWriter;

  constructor(
    private readonly reader: ShopifyWhatsAppConsentReader = new ShopifyWhatsAppConsentProvider(),
    database: PrismaClient = prisma,
    private readonly now: () => Date = () => new Date(),
    private readonly logger: Pick<StructuredLogger, "warn" | "info"> = defaultLogger,
  ) {
    this.recipients = new ShopifyConsentRecipientResolver(database);
    this.writes = new ShopifyConsentProjectionWriter(database, this.recipients, logger);
  }

  async syncCustomer(input: {
    shopId: string;
    shopifyCustomerId: string;
  }): Promise<ShopifyWhatsAppConsentSyncResult> {
    const scoped = await this.recipients.resolveCustomer(input.shopId, input.shopifyCustomerId);
    if (!scoped.ok) return scoped.failure;
    return this.refresh(scoped.value);
  }

  async evaluateRecipient(input: {
    shopId: string;
    customerId: string;
    shopifyCustomerId: string;
    recipient: string;
  }): Promise<ShopifyWhatsAppConsentEligibility> {
    const scoped = await this.recipients.resolveCustomer(input.shopId, input.shopifyCustomerId, input.customerId);
    if (!scoped.ok) return scoped.failure;
    const expected = await this.recipients.findRecipient(scoped.value, input.recipient);
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
    const scoped = await this.recipients.resolveCustomerById(input.shopId, input.customerId);
    if (!scoped.ok) return scoped.failure;
    const match = await this.recipients.findRecipient(scoped.value, input.recipient);
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
      const invalidated = await this.writes.invalidateOtherNumbers(scoped, null, startedAt);
      if (invalidated.failure) return invalidated.failure;
      return notAuthorised("SHOPIFY_CUSTOMER_OR_PHONE_NOT_FOUND");
    }
    if (observation.customerGid !== scoped.identity.gid) {
      return unavailable("SHOPIFY_IDENTITY_MISMATCH");
    }
    const providerCanonical = this.recipients.canonical(observation.phoneNumber, scoped.shop);
    if (!providerCanonical) return unavailable("INVALID_SHOPIFY_PHONE");

    const updatedAt = observation.updatedAt === null ? startedAt : new Date(observation.updatedAt);
    const verifiedAt = this.now();
    if (!Number.isFinite(updatedAt.getTime()) || updatedAt.getTime() > verifiedAt.getTime()) {
      return unavailable("INVALID_SHOPIFY_OBSERVATION_TIME");
    }
    const invalidated = await this.writes.invalidateOtherNumbers(scoped, providerCanonical, updatedAt);
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
    const match = await this.recipients.findRecipient(scoped, observation.phoneNumber);
    if (!match.ok) return match.failure;
    if (expected && expected.phone.id !== match.phone.id) {
      return notAuthorised("ACTIVE_RECIPIENT_CHANGED");
    }
    const decision = observation.state === "SUBSCRIBED" ? "GRANTED" :
      observation.state === "UNSUBSCRIBED" ? "REVOKED" : "UNKNOWN";
    return this.writes.persist(scoped, match.phone.id, match.canonical, decision, updatedAt, verifiedAt);
  }
}
