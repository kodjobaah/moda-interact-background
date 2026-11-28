import type { PrismaClient } from "@prisma/client";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import prisma from "../lib/db.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";
import { ShopifyConsentRecipientResolver } from "./shopify-whatsapp-consent/recipient.js";
import { ShopifyConsentProjectionWriter } from "./shopify-whatsapp-consent/projection-writer.js";
import { evaluateShopifyStoredRecipient } from "./shopify-whatsapp-consent/phone-resolution.js";
import { type ShopifyConsentMaterializationResult } from "./shopify-whatsapp-consent/types.js";
import type {
  ShopifyWhatsAppConsentEligibility,
  ShopifyWhatsAppConsentSyncResult,
} from "./shopify-whatsapp-consent/types.js";

export type {
  ShopifyWhatsAppConsentEligibility,
  ShopifyWhatsAppConsentSyncResult,
} from "./shopify-whatsapp-consent/types.js";

export interface ShopifyWhatsAppConsentServicePort {
  syncCustomer(input: {
    shopId: string;
    shopifyCustomerId: string;
  }): Promise<ShopifyWhatsAppConsentSyncResult>;
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
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

/** Reads the current SQL permission and materialises verified checkout receipts. */
export class ShopifyWhatsAppConsentService implements ShopifyWhatsAppConsentServicePort {
  private readonly recipients: ShopifyConsentRecipientResolver;
  private readonly writes: ShopifyConsentProjectionWriter;

  constructor(
    private readonly database: PrismaClient = prisma,
    private readonly now: () => Date = () => new Date(),
    private readonly logger: Pick<
      StructuredLogger,
      "warn" | "info" | "error"
    > = defaultLogger,
  ) {
    this.recipients = new ShopifyConsentRecipientResolver(database);
    this.writes = new ShopifyConsentProjectionWriter(
      database,
      this.recipients,
      logger,
    );
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
    const scoped = await this.recipients.resolveCustomer(
      input.shopId,
      input.shopifyCustomerId,
      input.customerId,
    );
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
    const target = await this.recipients.findRecipient(
      scoped.value,
      input.recipient,
    );
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
      return {
        status: "MATERIALISATION_FAILURE",
        reason: result.reason,
        ...("cause" in result && result.cause !== undefined
          ? { cause: result.cause }
          : {}),
      };
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
    return evaluateShopifyStoredRecipient({
      ...input,
      database: this.database,
    });
  }
}
