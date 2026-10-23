import { createHash } from "node:crypto";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import {
  ShopifyWhatsAppConsentService,
  type ShopifyWhatsAppConsentServicePort,
  type ShopifyWhatsAppConsentEligibility,
} from "../shopify-whatsapp-consent.service.js";
import {
  recoveryConsentNoticeService,
  type RecoveryConsentNoticeService,
  type RecoveryConsentNoticeReason,
} from "./recovery-consent-notice.service.js";

const logger = createLogger({
  serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName(),
});

export const SHOPIFY_RECOVERY_CONSENT_RETRY_REQUIRED = "SHOPIFY_RECOVERY_CONSENT_RETRY_REQUIRED";

export interface RecoveryConsentAdmissionPort {
  evaluateFirst(input: {
    shopId: string; checkoutToken: string; customerId: string | null;
    shopifyCustomerId: string | null; recipient: string | null;
  }): Promise<boolean>;
  evaluateReentry(input: {
    shopId: string; checkoutToken: string; customerId: string | null;
    recipient: string | null;
  }): Promise<boolean>;
  notifyMissingRecipient(input: { shopId: string; checkoutToken: string }): Promise<void>;
}

/** One native refresh per new checkout; established recoveries read stored permission only. */
export class RecoveryConsentAdmissionService implements RecoveryConsentAdmissionPort {
  constructor(
    private readonly consent: Pick<ShopifyWhatsAppConsentServicePort, "evaluateRecipient" | "evaluateStoredRecipient"> =
      new ShopifyWhatsAppConsentService(),
    private readonly notices: Pick<RecoveryConsentNoticeService, "publish"> = recoveryConsentNoticeService,
  ) {}

  async evaluateFirst(input: {
    shopId: string; checkoutToken: string; customerId: string | null;
    shopifyCustomerId: string | null; recipient: string | null;
  }): Promise<boolean> {
    if (!input.customerId || !input.shopifyCustomerId || !input.recipient) {
      await this.notice(input, "RECIPIENT_UNVERIFIED");
      return false;
    }
    const outcome = await this.consent.evaluateRecipient({
      shopId: input.shopId,
      customerId: input.customerId,
      shopifyCustomerId: input.shopifyCustomerId,
      recipient: input.recipient,
    });
    return this.decide(input, outcome);
  }

  async evaluateReentry(input: {
    shopId: string; checkoutToken: string; customerId: string | null;
    recipient: string | null;
  }): Promise<boolean> {
    if (!input.customerId || !input.recipient) {
      await this.notice(input, "RECIPIENT_UNVERIFIED");
      return false;
    }
    const outcome = await this.consent.evaluateStoredRecipient({
      shopId: input.shopId, customerId: input.customerId, recipient: input.recipient,
    });
    return this.decide(input, outcome);
  }

  async notifyMissingRecipient(input: { shopId: string; checkoutToken: string }): Promise<void> {
    await this.notice(input, "RECIPIENT_UNVERIFIED");
  }

  private async decide(
    input: { shopId: string; checkoutToken: string },
    outcome: ShopifyWhatsAppConsentEligibility,
  ): Promise<boolean> {
    if (outcome.status === "ALLOWED") return true;
    if (outcome.status === "NOT_AUTHORISED" && outcome.reason === "LOCAL_NO_CONTACT") {
      // BACKGROUND-005 already informed the merchant about STOP. Never reclassify STOP
      // as a lack of Shopify opt-in, even following a fresh Shopify grant.
      return false;
    }
    let reason: RecoveryConsentNoticeReason;
    if (outcome.status === "UNAVAILABLE") reason = "VERIFICATION_UNAVAILABLE";
    else if (outcome.status === "NOT_AUTHORISED" && outcome.reason === "NATIVE_CONSENT_NOT_GRANTED") {
      reason = "NO_VERIFIED_OPT_IN";
    } else reason = "RECIPIENT_UNVERIFIED";
    await this.notice(input, reason);
    if (outcome.status === "UNAVAILABLE") {
      // Let the existing bounded BullMQ retry policy retry the ordinary job;
      // no separate consent poller, pending index, or DETECTED wait row.
      throw new Error(SHOPIFY_RECOVERY_CONSENT_RETRY_REQUIRED);
    }
    return false;
  }

  private async notice(
    input: { shopId: string; checkoutToken: string },
    reason: RecoveryConsentNoticeReason,
  ): Promise<void> {
    await this.notices.publish({ ...input, reason });
    const checkoutRef = createHash("sha256")
      .update(JSON.stringify(["shopify-checkout-consent:v1", input.shopId, input.checkoutToken]))
      .digest("hex").slice(0, 16);
    logger.info("recovery.consent.admission", {
      shopId: input.shopId, checkoutRef, reasonCode: reason, outcome: "blocked",
    });
  }
}

export const recoveryConsentAdmissionService = new RecoveryConsentAdmissionService();
