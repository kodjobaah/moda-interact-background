import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import prisma from "../lib/db.js";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import type { NormalizedAbandonedCheckout } from "../domain/abandoned-checkout.js";
import type { PendingRecoveryCandidate } from "../domain/pending-recovery-candidate.js";
import type { RecoveryCheckoutSeed } from "../events/checkout-events.js";
import { verifyShopifyConsentReceipt } from "./shopify-consent-receipt-verifier.js";
import {
  materializeShopifyCheckoutPhones,
  ShopifyPhoneResolutionError,
} from "./shopify-whatsapp-consent/phone-resolution.js";
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
  | { status: "MATERIALISED_GRANTED"; recipient: string; customerId: string }
  | { status: "MATERIALISED_REVOKED" };

/** Only authenticated, recoverable Shopify checkout receipts may modify consent. */
export class ShopifyCheckoutConsentMaterializationService {
  constructor(
    private readonly keyringJson: () => string | undefined = () =>
      process.env.MODA_ENCRYPTION_KEYS_JSON,
    private readonly now: () => Date = () => new Date(),
    private readonly logger: Pick<
      StructuredLogger,
      "info" | "warn" | "error"
    > = materializationLogger,
    private readonly database: PrismaClient = prisma,
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
      verifiedShopifyCustomerId:
        input.checkout.customer?.shopifyCustomerId ?? null,
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
          ...(verification.cause !== undefined
            ? { error: verification.cause }
            : {}),
        });
        return {
          status: "MATERIALISATION_FAILURE",
          reason: verification.reason,
          ...(verification.cause !== undefined
            ? { cause: verification.cause }
            : {}),
        };
      }
      this.logger.info("shopify.consent.receipt.evaluation", {
        ...logContext,
        stage: "receipt_verification",
        outcome: verification.status,
      });
      return { status: verification.status };
    }
    if (input.checkout.consentReceiptAttribute.kind !== "VALUE") {
      return { status: "INVALID_OR_AMBIGUOUS_RECEIPT" };
    }

    try {
      const resolved = await materializeShopifyCheckoutPhones({
        shopId: input.candidate.shopId,
        checkout: input.checkout,
        decision: verification.decision,
        acceptedAt: verification.acceptedAt,
        locale: verification.locale,
        receiptKind: verification.kind,
        receiptValue: input.checkout.consentReceiptAttribute.value,
        checkoutToken: input.candidate.checkoutToken,
        cartToken: input.candidate.cartToken,
        now: this.now(),
        database: this.database,
      });
      this.logger.info("shopify.recovery.phone_consent_evaluation", {
        ...logContext,
        shopifyCustomerIdPresent: Boolean(
          input.checkout.customer?.shopifyCustomerId,
        ),
        customerPhonePresent: Boolean(input.checkout.customer?.phone),
        billingPhonePresent: Boolean(input.checkout.billingPhone),
        shippingPhonePresent: Boolean(input.checkout.shippingPhone),
        validDistinctPhoneCount: resolved.validPhoneCount,
        invalidPhoneSources: resolved.invalidSources,
        verifiedDecision: verification.decision,
        consentWriteCount: resolved.consentWriteCount,
        evidenceInsertedCount: resolved.evidenceInsertedCount,
        selectedRecipientSource: resolved.selected?.source ?? null,
        outcome: resolved.selected ? "eligible" : "no_eligible_recipient",
      });
      if (resolved.selected)
        return {
          status: "MATERIALISED_GRANTED",
          customerId: resolved.customerId,
          recipient: resolved.selected.recipient,
        };
      if (verification.decision === "REVOKED")
        return { status: "MATERIALISED_REVOKED" };
      return { status: "BLOCKED_STOP" };
    } catch (error) {
      if (error instanceof ShopifyPhoneResolutionError) {
        this.logger.warn("shopify.consent.receipt.identity_deferred", {
          ...logContext,
          stage: "shopify_phone_resolution",
          outcome: "deferred",
          reasonCode: error.reasonCode,
          message: error.message,
        });
        return { status: "DEFER_IDENTITY_OR_RECIPIENT" };
      }
      this.logger.error("shopify.consent.materialization.failed", {
        ...logContext,
        stage: "postgresql_write",
        outcome: "retryable_failure",
        reasonCode: "CONSENT_WRITE_FAILED",
        error,
      });
      return {
        status: "MATERIALISATION_FAILURE",
        reason: "CONSENT_WRITE_FAILED",
        cause: error,
      };
    }
  }
}

export const shopifyCheckoutConsentMaterializationService =
  new ShopifyCheckoutConsentMaterializationService();
