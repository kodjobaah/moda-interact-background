/** Background-local contract for a merchant Support notice, not a WhatsApp send. */
export type RecoveryConsentNoticePlatform = "SHOPIFY" | "WOOCOMMERCE";
export type RecoveryConsentNoticeReason =
  | "NO_VERIFIED_OPT_IN"
  | "RECIPIENT_UNVERIFIED"
  | "RECIPIENT_AMBIGUOUS"
  | "VERIFICATION_UNAVAILABLE";
export type RecoveryConsentBlockedOperation =
  | "CREATE_FIRST_RECOVERY"
  | "SEND_INITIAL_RECOVERY";

export type RecoveryConsentCheckoutContext = Readonly<{
  customerName?: string;
  customerEmail?: string;
  checkoutTotal?: Readonly<{ amountDecimal: string; currency: string }>;
  itemCount?: number;
  lastActivityAt?: string;
  merchantVisibleReference?: string;
}>;

export type RecoveryConsentNoticeInput = Readonly<{
  shopId: string;
  platform: RecoveryConsentNoticePlatform;
  checkoutToken: string; // INTERNAL ONLY: never render or log
  reason: RecoveryConsentNoticeReason;
  blockedOperation: RecoveryConsentBlockedOperation;
  context?: RecoveryConsentCheckoutContext;
}>;

export type RecoveryConsentNoticeResult = "created" | "duplicate";
export interface RecoveryConsentMerchantNotifier {
  notify(input: RecoveryConsentNoticeInput): Promise<RecoveryConsentNoticeResult>;
}
