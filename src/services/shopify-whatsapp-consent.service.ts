import type { PrismaClient } from "@prisma/client";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import prisma from "../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { ShopifyConsentRecipientResolver } from "./shopify-whatsapp-consent/recipient.js";
import { ShopifyConsentProjectionWriter } from "./shopify-whatsapp-consent/projection-writer.js";
import {
  notAuthorised,
  type ShopifyConsentMaterializationResult,
} from "./shopify-whatsapp-consent/types.js";
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
  materializeExplicitChoice(input: {
    shopId: string;
    customerId?: string;
    shopifyCustomerId: string;
    recipient: string;
    decision: "GRANTED" | "REVOKED";
  }): Promise<ShopifyConsentMaterializationResult>;
}

const defaultLogger = createLogger({
  serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName(),
});

/** Reads the current SQL permission and materialises verified checkout receipts. */
export class ShopifyWhatsAppConsentService implements ShopifyWhatsAppConsentServicePort {
  private readonly recipients: ShopifyConsentRecipientResolver;
  private readonly writes: ShopifyConsentProjectionWriter;

  constructor(
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
    // Shopify's defaultPhoneNumber marketing field is not consent evidence for
    // ARCH-077. The legacy sync queue is retained for compatibility, but it
    // must not issue a provider read or change the verified SQL projection.
    void input;
    return { status: "NOT_AUTHORISED", reason: "SIGNED_RECEIPT_REQUIRED" };
  }

  async evaluateRecipient(input: {
    shopId: string;
    customerId: string;
    shopifyCustomerId: string;
    recipient: string;
  }): Promise<ShopifyWhatsAppConsentEligibility> {
    const scoped = await this.recipients.resolveCustomer(input.shopId, input.shopifyCustomerId, input.customerId);
    if (!scoped.ok) return scoped.failure;
    return this.evaluateStoredRecipient({
      shopId: input.shopId,
      customerId: input.customerId,
      recipient: input.recipient,
    });
  }

  async materializeExplicitChoice(input: {
    shopId: string;
    customerId?: string;
    shopifyCustomerId: string;
    recipient: string;
    decision: "GRANTED" | "REVOKED";
  }): Promise<ShopifyConsentMaterializationResult> {
    const scoped = await this.recipients.resolveCustomer(
      input.shopId,
      input.shopifyCustomerId,
      input.customerId,
    );
    if (!scoped.ok) return { status: "DEFER_IDENTITY_OR_RECIPIENT" };
    const target = await this.recipients.findRecipient(scoped.value, input.recipient);
    if (!target.ok) return { status: "DEFER_IDENTITY_OR_RECIPIENT" };
    if (target.phone.whatsappNoContact && input.decision === "GRANTED") {
      return { status: "BLOCKED_STOP" };
    }

    const verifiedAt = this.now();
    const result = await this.writes.persist(
      scoped.value,
      target.phone.id,
      target.canonical,
      input.decision,
      verifiedAt,
      verifiedAt,
    );
    if ("reason" in result) {
      if (result.status === "NOT_AUTHORISED") {
        return result.reason === "LOCAL_NO_CONTACT"
          ? { status: "BLOCKED_STOP" }
          : { status: "DEFER_IDENTITY_OR_RECIPIENT" };
      }
      return { status: "MATERIALISATION_FAILURE", reason: result.reason };
    }
    return input.decision === "GRANTED"
      ? { status: "MATERIALISED_GRANTED" }
      : { status: "MATERIALISED_REVOKED" };
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
    // Local STOP and merchant suppression override any receipt-derived state.
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

}
