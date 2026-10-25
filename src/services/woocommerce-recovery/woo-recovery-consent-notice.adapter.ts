import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import type {
  RecoveryConsentCheckoutContext,
  RecoveryConsentMerchantNotifier,
  RecoveryConsentNoticeInput,
  RecoveryConsentNoticeReason,
} from "../checkout-recovery/recovery-consent-merchant-notice.contracts.js";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import type { WooCandidateManager, WooPendingCandidate } from "./contracts.js";
import {
  SHOP_ID,
  SOURCE_ID,
  validActivity,
} from "./woo-recovery-admission-evidence.js";
import type {
  WooAdmissionDenialReason,
  WooDeniedAdmission,
  WooRecoveryAdmissionDependencies,
} from "./woo-recovery-admission.service.js";

const defaultLogger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});

type NoticeLogger = Pick<StructuredLogger, "info" | "error">;

/** Every BG003 denial reason must be consciously included or excluded. */
const NOTICE_REASON = {
  CONSENT_NOT_GRANTED: "NO_VERIFIED_OPT_IN",
  CONSENT_AMBIGUOUS: "RECIPIENT_AMBIGUOUS",
  RECIPIENT_MISSING: "RECIPIENT_UNVERIFIED",
  RECIPIENT_INVALID: "RECIPIENT_UNVERIFIED",
  RECIPIENT_IDENTITY_MISMATCH: "RECIPIENT_UNVERIFIED",
  CONSENT_RECIPIENT_UNVERIFIED: "RECIPIENT_UNVERIFIED",
  CONSENT_NO_CONTACT: null, // The authoritative STOP/no-contact path notifies separately.
  CONSENT_CHANGED: null, // Concurrent consent changes require reconciliation, not a refusal notice.
  INVALID_CANDIDATE: null,
  SHOP_NOT_ELIGIBLE: null,
  INSTALLATION_INACTIVE: null,
  BASKET_EMPTY: null,
  BASKET_INVALID: null,
} as const satisfies Record<WooAdmissionDenialReason, RecoveryConsentNoticeReason | null>;

const WOO_MONEY = /^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_ITEMS = 50;
const MAX_NOTICE_ITEM_COUNT = 100_000;

function isDenialReason(value: unknown): value is WooAdmissionDenialReason {
  return typeof value === "string" && Object.hasOwn(NOTICE_REASON, value);
}

/**
 * The BG001 accepted-candidate store is the sole optional context source.
 * Its values never establish authenticated customer identity on their own.
 * An absent, completed or mismatched candidate produces a context-free notice.
 */
function contextFromAcceptedCandidate(
  denial: WooDeniedAdmission,
  candidate: WooPendingCandidate | null,
): RecoveryConsentCheckoutContext | undefined {
  if (!candidate || candidate.source !== "woocommerce" ||
    candidate.shopId !== denial.shopId || candidate.checkoutToken !== denial.checkoutToken ||
    !SOURCE_ID.test(candidate.lastEventId) || !validActivity(candidate.lastActivityAt)) {
    return undefined;
  }

  const context: {
    -readonly [K in keyof RecoveryConsentCheckoutContext]?: RecoveryConsentCheckoutContext[K];
  } = { lastActivityAt: candidate.lastActivityAt };

  if (candidate.basket?.kind !== "nonempty" || !candidate.basket.checkout) return context;
  const checkout = candidate.basket.checkout;
  if (typeof checkout.total === "string" && WOO_MONEY.test(checkout.total) &&
    typeof checkout.currency === "string" && CURRENCY.test(checkout.currency)) {
    context.checkoutTotal = { amountDecimal: checkout.total, currency: checkout.currency };
  }

  // Invalid, omitted or oversized item evidence is UNKNOWN, never an empty cart.
  const items = checkout.items;
  if (Array.isArray(items) && items.length > 0 && items.length <= MAX_ITEMS &&
    items.every((item) => item && Number.isSafeInteger(item.quantity) &&
      item.quantity >= 1 && item.quantity <= MAX_NOTICE_ITEM_COUNT)) {
    const quantity = items.reduce<number>((sum, item) => sum + item.quantity, 0);
    if (Number.isSafeInteger(quantity) && quantity <= MAX_NOTICE_ITEM_COUNT) {
      context.itemCount = quantity;
    }
  }

  // BG003 establishes a canonical, unambiguous recipient before it can report
  // CONSENT_NOT_GRANTED. All other denial reasons leave identity unresolved:
  // do not label checkout-provided contact information as an identified customer.
  if (denial.reason === "CONSENT_NOT_GRANTED" &&
    typeof checkout.contact?.phone === "string" && checkout.contact.phone.trim()) {
    const contact = checkout.contact;
    const names = [contact.firstName, contact.lastName].filter(
      (part): part is string => typeof part === "string" && part.length <= 100 && !!part.trim(),
    );
    if (names.length) context.customerName = names.join(" ");
    if (typeof contact.email === "string" && contact.email.length <= 254) {
      context.customerEmail = contact.email;
    }
  }

  // Woo activity.v1 has no merchant-visible reference. In particular,
  // checkoutToken/checkoutKey, event ID and phone must never be substituted.
  return context;
}

function logSafely(
  logger: NoticeLogger,
  level: "info" | "error",
  event: string,
  fields: Record<string, string>,
): void {
  // The shared logger's sink is diagnostic, never a correctness dependency.
  try { logger[level](event, fields); } catch { /* sink unavailable */ }
}

export type WooRecoveryConsentNoticeAdapterDependencies = Readonly<{
  candidates: Pick<WooCandidateManager, "getPending">;
  notifier: RecoveryConsentMerchantNotifier;
  logger?: NoticeLogger;
}>;

/**
 * ARCH-046-BACKGROUND-002: Woo-only adapter for BG003's awaited denial seam.
 * BG005 owns injecting the returned callback into the admission worker.
 */
export function createWooRecoveryConsentDeniedAdmissionNotifier(
  deps: WooRecoveryConsentNoticeAdapterDependencies,
): NonNullable<WooRecoveryAdmissionDependencies["onDeniedAdmission"]> {
  const logger = deps.logger ?? defaultLogger;

  return async (denial: WooDeniedAdmission): Promise<void> => {
    const fields: Record<string, string> = {
      ...(denial && typeof denial.shopId === "string" && SHOP_ID.test(denial.shopId)
        ? { shopId: denial.shopId } : {}),
      reasonCode: isDenialReason(denial?.reason) ? denial.reason : "UNKNOWN_DENIAL_REASON",
    };
    let stage = "validate";
    try {
      if (!denial || !SHOP_ID.test(denial.shopId) || !SOURCE_ID.test(denial.checkoutToken)) {
        throw new TypeError("Invalid Woo denial shopId or checkoutToken");
      }
      if (!isDenialReason(denial.reason)) {
        throw new TypeError("Unknown Woo admission denial reason");
      }
      const mapped = NOTICE_REASON[denial.reason];
      if (mapped === null) {
        logSafely(logger, "info", "woocommerce.recovery.consent_notice.skipped", {
          ...fields, outcome: "excluded",
        });
        return;
      }

      stage = "candidate_read";
      const candidate = await deps.candidates.getPending({
        shopId: denial.shopId, checkoutToken: denial.checkoutToken,
      });
      const context = contextFromAcceptedCandidate(denial, candidate);
      const notice: RecoveryConsentNoticeInput = {
        shopId: denial.shopId,
        checkoutToken: denial.checkoutToken,
        platform: "WOOCOMMERCE",
        reason: mapped,
        blockedOperation: "CREATE_FIRST_RECOVERY",
        ...(context ? { context } : {}),
      };

      stage = "notice_write";
      const outcome = await deps.notifier.notify(notice);
      if (outcome !== "created" && outcome !== "duplicate") {
        throw new Error("Invalid recovery consent notifier outcome");
      }
      logSafely(logger, "info", "woocommerce.recovery.consent_notice.recorded", {
        ...fields, outcome, context: context ? "accepted_snapshot" : "unavailable",
      });
    } catch (error) {
      logSafely(logger, "error", "woocommerce.recovery.consent_notice.failed", {
        ...fields, stage, outcome: "failed",
      });
      // Do not turn Redis, database or notifier failures into a successful denial.
      throw error;
    }
  };
}
