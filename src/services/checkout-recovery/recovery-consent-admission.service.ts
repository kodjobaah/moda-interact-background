import {
  ShopifyWhatsAppConsentService,
  type ShopifyWhatsAppConsentServicePort,
  type ShopifyWhatsAppConsentEligibility,
} from "../shopify-whatsapp-consent.service.js";
import type {
  RecoveryConsentBlockedOperation,
  RecoveryConsentCheckoutContext,
  RecoveryConsentMerchantNotifier,
  RecoveryConsentNoticeReason,
} from "./recovery-consent-merchant-notice.contracts.js";
import { recoveryConsentMerchantNoticeService } from "./recovery-consent-merchant-notice.service.js";

export const SHOPIFY_RECOVERY_CONSENT_RETRY_REQUIRED = "SHOPIFY_RECOVERY_CONSENT_RETRY_REQUIRED";

type ShopifyNoticeContext = {
  shopId: string;
  checkoutToken: string;
  noticeContext?: RecoveryConsentCheckoutContext;
};
type FirstInput = ShopifyNoticeContext & {
  customerId: string | null;
  shopifyCustomerId: string | null;
  recipient: string | null;
};
type ReentryInput = ShopifyNoticeContext & {
  customerId: string | null;
  recipient: string | null;
};

export interface RecoveryConsentAdmissionPort {
  evaluateFirst(input: FirstInput): Promise<boolean>;
  evaluateReentry(input: ReentryInput): Promise<boolean>;
  notifyMissingRecipient(input: ShopifyNoticeContext): Promise<void>;
}

/** Shopify decides eligibility. Shared notifier only reports an already-denied admission. */
export class RecoveryConsentAdmissionService implements RecoveryConsentAdmissionPort {
  constructor(
    private readonly consent: Pick<ShopifyWhatsAppConsentServicePort, "evaluateRecipient" | "evaluateStoredRecipient"> =
      new ShopifyWhatsAppConsentService(),
    private readonly notices: RecoveryConsentMerchantNotifier = recoveryConsentMerchantNoticeService,
  ) {}

  async evaluateFirst(input: FirstInput): Promise<boolean> {
    if (!input.customerId || !input.shopifyCustomerId || !input.recipient) {
      await this.notice(input, "RECIPIENT_UNVERIFIED", "CREATE_FIRST_RECOVERY");
      return false;
    }
    const outcome = await this.consent.evaluateRecipient({
      shopId: input.shopId,
      customerId: input.customerId,
      shopifyCustomerId: input.shopifyCustomerId,
      recipient: input.recipient,
    });
    return this.decide(input, outcome, "CREATE_FIRST_RECOVERY");
  }

  async evaluateReentry(input: ReentryInput): Promise<boolean> {
    if (!input.customerId || !input.recipient) {
      await this.notice(input, "RECIPIENT_UNVERIFIED", "SEND_INITIAL_RECOVERY");
      return false;
    }
    const outcome = await this.consent.evaluateStoredRecipient({
      shopId: input.shopId, customerId: input.customerId, recipient: input.recipient,
    });
    return this.decide(input, outcome, "SEND_INITIAL_RECOVERY");
  }

  async notifyMissingRecipient(input: ShopifyNoticeContext): Promise<void> {
    await this.notice(input, "RECIPIENT_UNVERIFIED", "SEND_INITIAL_RECOVERY");
  }

  private async decide(
    input: ShopifyNoticeContext,
    outcome: ShopifyWhatsAppConsentEligibility,
    blockedOperation: RecoveryConsentBlockedOperation,
  ): Promise<boolean> {
    if (outcome.status === "ALLOWED") return true;
    if (outcome.status === "NOT_AUTHORISED" && outcome.reason === "LOCAL_NO_CONTACT") {
      // STOP already has an independent merchant notice. Never reclassify it.
      return false;
    }
    let reason: RecoveryConsentNoticeReason;
    if (outcome.status === "UNAVAILABLE") reason = "VERIFICATION_UNAVAILABLE";
    else if (outcome.status === "AMBIGUOUS") reason = "RECIPIENT_AMBIGUOUS";
    else if (outcome.status === "NOT_AUTHORISED" && outcome.reason === "NATIVE_CONSENT_NOT_GRANTED") {
      reason = "NO_VERIFIED_OPT_IN";
    } else reason = "RECIPIENT_UNVERIFIED";
    await this.notice(input, reason, blockedOperation);
    if (outcome.status === "UNAVAILABLE") {
      // Preserve the existing bounded Shopify retry after the notice has committed.
      throw new Error(SHOPIFY_RECOVERY_CONSENT_RETRY_REQUIRED);
    }
    return false;
  }

  private async notice(
    input: ShopifyNoticeContext,
    reason: RecoveryConsentNoticeReason,
    blockedOperation: RecoveryConsentBlockedOperation,
  ): Promise<void> {
    await this.notices.notify({
      shopId: input.shopId, checkoutToken: input.checkoutToken, platform: "SHOPIFY",
      reason, blockedOperation,
      ...(input.noticeContext ? { context: input.noticeContext } : {}),
    });
  }
}

export const recoveryConsentAdmissionService = new RecoveryConsentAdmissionService();
