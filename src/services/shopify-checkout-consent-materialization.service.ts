import { createHash } from "node:crypto";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { normalizeRecipientPhone } from "@modainteract/moda-interact-shared/identity";
import type { NormalizedAbandonedCheckout } from "../domain/abandoned-checkout.js";
import type { PendingRecoveryCandidate } from "../domain/pending-recovery-candidate.js";
import type { RecoveryCheckoutSeed } from "../events/checkout-events.js";
import { recoveryShopifyCustomerService } from "./checkout-recovery/recovery-shopify-customer.service.js";
import {
  ShopifyWhatsAppConsentService,
  type ShopifyWhatsAppConsentServicePort,
} from "./shopify-whatsapp-consent.service.js";
import { verifyShopifyConsentReceipt } from "./shopify-consent-receipt-verifier.js";
import type { ShopifyConsentMaterializationResult } from "./shopify-whatsapp-consent/types.js";
import { resolveDeploymentEnvironmentName } from "../runtime/deployment-environment.js";

const materializationLogger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

export type ShopifyCheckoutConsentMaterialization =
  | { status: "NO_EXPLICIT_CHOICE" }
  | { status: "INVALID_OR_AMBIGUOUS_RECEIPT" }
  | { status: "DEFER_CHECKOUT_BINDING" }
  | { status: "DEFER_IDENTITY_OR_RECIPIENT" }
  | { status: "BLOCKED_STOP" }
  | { status: "MATERIALISATION_FAILURE"; reason: string; cause?: unknown }
  | { status: "MATERIALISED_GRANTED"; recipient: string }
  | { status: "MATERIALISED_REVOKED" };

type CustomerPreparer = (seed: RecoveryCheckoutSeed, shopId: string) => Promise<unknown>;

/** Applies an authenticated receipt only after the caller has established recoverability. */
export class ShopifyCheckoutConsentMaterializationService {
  constructor(
    private readonly consent: Pick<ShopifyWhatsAppConsentServicePort, "materializeExplicitChoice"> =
      new ShopifyWhatsAppConsentService(),
    private readonly prepareCustomer: CustomerPreparer = (seed, shopId) =>
      recoveryShopifyCustomerService.resolve(seed, shopId),
    private readonly keyringJson: () => string | undefined = () =>
      process.env.MODA_ENCRYPTION_KEYS_JSON,
    private readonly now: () => Date = () => new Date(),
    private readonly logger: Pick<StructuredLogger, "info" | "warn" | "error"> = materializationLogger,
  ) {}

  async materialize(input: {
    candidate: PendingRecoveryCandidate;
    checkout: NormalizedAbandonedCheckout;
    seed: RecoveryCheckoutSeed;
  }): Promise<ShopifyCheckoutConsentMaterialization> {
    const checkoutCorrelation = createHash("sha256")
      .update(input.candidate.checkoutToken)
      .digest("hex")
      .slice(0, 16);
    const logContext = {
      shopId: input.candidate.shopId,
      checkoutCorrelation,
      operation: "materialize_checkout_consent",
    };
    const keyringJson = this.keyringJson();
    const verification = verifyShopifyConsentReceipt({
      attribute: input.checkout.consentReceiptAttribute,
      shopId: input.candidate.shopId,
      shopifyPlus: input.checkout.shopifyPlus,
      cartToken: input.candidate.cartToken,
      checkoutToken: input.candidate.checkoutToken,
      verifiedShopifyCustomerId: input.checkout.customer?.shopifyCustomerId ?? null,
      ...(keyringJson !== undefined ? { keyringJson } : {}),
      now: this.now(),
      logger: this.logger,
    });
    if (verification.status !== "VERIFIED") {
      if (verification.status === "KEYRING_CONFIGURATION_FAILURE") {
        this.logger.error("shopify.consent.materialization.failed", {
          ...logContext,
          stage: "receipt_keyring",
          outcome: "retryable_failure",
          reasonCode: verification.reason,
          ...(verification.cause !== undefined ? { error: verification.cause } : {}),
        });
        return {
          status: "MATERIALISATION_FAILURE",
          reason: verification.reason,
          ...(verification.cause !== undefined ? { cause: verification.cause } : {}),
        };
      }
      if (verification.status === "NO_EXPLICIT_CHOICE") {
        this.logger.info("shopify.consent.materialization.no_choice", {
          ...logContext,
          stage: "receipt_verification",
          outcome: "unchanged",
          reasonCode: "NO_EXPLICIT_CHOICE",
        });
      } else if (verification.status === "DEFER_IDENTITY_OR_RECIPIENT" ||
          verification.status === "DEFER_CHECKOUT_BINDING") {
        this.logger.info("shopify.consent.receipt.identity_deferred", {
          ...logContext,
          stage: "checkout_identity",
          outcome: "deferred",
          reasonCode: verification.status,
          message: "Consent receipt cannot be applied without verified checkout and customer binding.",
        });
      }
      return { status: verification.status };
    }

    const shopifyCustomerId = input.checkout.customer?.shopifyCustomerId;
    if (!shopifyCustomerId || verification.customerId === "-") {
      this.logger.info("shopify.consent.receipt.identity_deferred", {
        ...logContext,
        stage: "checkout_identity",
        outcome: "deferred",
        reasonCode: "VERIFIED_CUSTOMER_PRINCIPAL_REQUIRED",
        message: "Guest receipts are not materialised without a verified Shopify customer principal.",
      });
      return { status: "DEFER_IDENTITY_OR_RECIPIENT" };
    }

    const chosen = selectAttributedRecipient(input.checkout);
    if (!chosen) {
      this.logger.info("shopify.consent.receipt.identity_deferred", {
        ...logContext,
        stage: "recipient_attribution",
        outcome: "deferred",
        reasonCode: "ATTRIBUTABLE_RECIPIENT_MISSING",
        message: "No eligible customer, billing, or attributable shipping recipient was found.",
      });
      return { status: "DEFER_IDENTITY_OR_RECIPIENT" };
    }
    const seed: RecoveryCheckoutSeed = {
      ...input.seed,
      customer: { ...input.seed.customer, phone: chosen.phone },
    };

    // A customer or billing phone can be attached to the authenticated
    // Shopify customer. Shipping-only numbers must already be attributable to
    // that customer's durable CustomerPhone row; never create a principal from
    // a shipping destination.
    if (chosen.source !== "shipping") {
      let customer: unknown;
      try {
        customer = await this.prepareCustomer(seed, input.candidate.shopId);
      } catch (error) {
        this.logger.error("shopify.consent.materialization.failed", {
          ...logContext,
          stage: "customer_identity_resolution",
          outcome: "retryable_failure",
          reasonCode: "CUSTOMER_IDENTITY_RESOLUTION_FAILED",
          error,
        });
        return {
          status: "MATERIALISATION_FAILURE",
          reason: "CUSTOMER_IDENTITY_RESOLUTION_FAILED",
          cause: error,
        };
      }
      if (!customer) return { status: "DEFER_IDENTITY_OR_RECIPIENT" };
    }

    let result: ShopifyConsentMaterializationResult;
    try {
      result = await this.consent.materializeExplicitChoice({
        shopId: input.candidate.shopId,
        shopifyCustomerId,
        recipient: chosen.e164,
        decision: verification.decision,
      });
    } catch (error) {
      this.logger.error("shopify.consent.materialization.failed", {
        ...logContext,
        stage: "postgresql_write",
        outcome: "retryable_failure",
        reasonCode: "CONSENT_WRITE_FAILED",
        error,
      });
      return { status: "MATERIALISATION_FAILURE", reason: "CONSENT_WRITE_FAILED", cause: error };
    }
    switch (result.status) {
      case "MATERIALISED_GRANTED":
        this.logger.info("shopify.consent.materialization.granted", {
          ...logContext,
          stage: "postgresql_write",
          outcome: "materialised",
          decision: verification.decision,
          reasonCode: "CONSENT_GRANTED",
        });
        return { status: result.status, recipient: chosen.e164.slice(1) };
      case "MATERIALISED_REVOKED":
        this.logger.info("shopify.consent.materialization.revoked", {
          ...logContext,
          stage: "postgresql_write",
          outcome: "materialised",
          decision: verification.decision,
          reasonCode: "CONSENT_REVOKED",
        });
        return result;
      case "BLOCKED_STOP":
        this.logger.info("shopify.consent.outbound.blocked", {
          ...logContext,
          stage: "stop_guard",
          outcome: "blocked",
          reasonCode: "BLOCKED_STOP",
          message: "Independent STOP/no-contact state prevents proactive consent materialisation.",
        });
        return result;
      case "DEFER_IDENTITY_OR_RECIPIENT":
        this.logger.info("shopify.consent.receipt.identity_deferred", {
          ...logContext,
          stage: "recipient_attribution",
          outcome: "deferred",
          reasonCode: "RECIPIENT_NOT_ATTRIBUTABLE",
          message: "The current SQL customer or recipient binding is not eligible for this decision.",
        });
        return result;
      case "MATERIALISATION_FAILURE":
        this.logger.error("shopify.consent.materialization.failed", {
          ...logContext,
          stage: "postgresql_write",
          outcome: "retryable_failure",
          reasonCode: result.reason,
          ...(result.cause !== undefined ? { error: result.cause } : {}),
        });
        return result;
    }
  }
}

function selectAttributedRecipient(
  checkout: NormalizedAbandonedCheckout,
): { source: "customer" | "billing" | "shipping"; phone: string; e164: string } | null {
  const country = checkout.internationalContext.countryCode ?? undefined;
  const choices = [
    { source: "customer" as const, phone: checkout.customer?.phone },
    { source: "billing" as const, phone: checkout.billingPhone },
    { source: "shipping" as const, phone: checkout.shippingPhone },
  ];
  for (const choice of choices) {
    if (!choice.phone?.trim()) continue;
    const normalized = normalizeRecipientPhone(
      choice.phone,
      choice.phone.trim().startsWith("+") || !country
        ? {}
        : { verifiedCountryCode: country },
    );
    if (normalized.ok) {
      return { source: choice.source, phone: choice.phone, e164: normalized.e164 };
    }
  }
  return null;
}

export const shopifyCheckoutConsentMaterializationService =
  new ShopifyCheckoutConsentMaterializationService();
