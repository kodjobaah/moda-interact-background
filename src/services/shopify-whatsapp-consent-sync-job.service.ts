import { parseShopifyCustomerIdentity } from "@modainteract/moda-interact-shared/identity";
import { safeParseShopifyWhatsAppConsentSyncJobV1 } from "@modainteract/moda-interact-shared/shopify";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { ShopifyWhatsAppConsentServicePort } from "./shopify-whatsapp-consent.service.js";

type ConsentSynchroniser = Pick<ShopifyWhatsAppConsentServicePort, "syncCustomer">;
type ConsentLogger = Pick<StructuredLogger, "info" | "warn">;
export type ConsentSyncJobOutcome = "updated" | "unchanged" | "skipped" | "stale";

/** Retry only transient read/write failures. The producer's checkout-events queue
 * already has a bounded, exponential three-attempt retry policy. */
export class ShopifyConsentSyncRetryableError extends Error {
  constructor(readonly reasonCode: string) {
    super(`Shopify WhatsApp consent refresh unavailable: ${reasonCode}`);
    this.name = "ShopifyConsentSyncRetryableError";
  }
}

function boundedReason(reason: string): string {
  return /^[A-Z0-9_]{1,72}$/.test(reason) ? reason : "UNSPECIFIED";
}

/** A consent webhook is a request to refresh CURRENT Shopify state, never consent evidence. */
export async function processShopifyWhatsAppConsentSyncJob(
  data: unknown,
  synchroniser: ConsentSynchroniser,
  logger: ConsentLogger,
): Promise<ConsentSyncJobOutcome> {
  const parsed = safeParseShopifyWhatsAppConsentSyncJobV1(data);
  if (!parsed.success) {
    // Do not include the untrusted payload or Zod's potentially sensitive input
    // in BullMQ failure records or logs. The failed job is retained by BullMQ.
    throw new Error("Invalid Shopify WhatsApp consent-sync job schema");
  }

  const { shopId, shopifyCustomerId } = parsed.data;
  // Both producers and consumers use the published Shared canonical identity.
  // Shopify IDs can exceed JS safe integer precision: never convert to number.
  const identity = parseShopifyCustomerIdentity(shopifyCustomerId);
  let result: Awaited<ReturnType<ConsentSynchroniser["syncCustomer"]>>;
  try {
    result = await synchroniser.syncCustomer({
      shopId,
      shopifyCustomerId: identity.numericId,
    });
  } catch (error) {
    logger.warn("shopify.whatsapp_consent.sync_job", {
      shopId, outcome: "retry", reasonCode: "SYNC_EXCEPTION",
      errorMessage: error instanceof Error ? error.message : String(error), error,
    });
    throw new ShopifyConsentSyncRetryableError("SYNC_EXCEPTION");
  }

  if (!("reason" in result)) {
    const outcome = result.status === "UPDATED" ? "updated" : "unchanged";
    logger.info("shopify.whatsapp_consent.sync_job", { shopId, outcome });
    return outcome;
  }

  const reasonCode = boundedReason(result.reason);
  if (result.status === "NOT_AUTHORISED" || result.status === "AMBIGUOUS") {
    // An absent, inactive, mismatched, or ambiguous shop/customer is never
    // fabricated from a phone number, and cannot authorise a recovery.
    logger.info("shopify.whatsapp_consent.sync_job", {
      shopId, outcome: "skipped", reasonCode,
    });
    return "skipped";
  }

  if (reasonCode === "STALE_OR_CONFLICTING_OBSERVATION") {
    // A newer provider observation already won the database monotonic fence.
    // Retrying an older observation must never roll back the local projection.
    logger.info("shopify.whatsapp_consent.sync_job", {
      shopId, outcome: "stale", reasonCode,
    });
    return "stale";
  }

  logger.warn("shopify.whatsapp_consent.sync_job", {
    shopId, outcome: "retry", reasonCode,
  });
  throw new ShopifyConsentSyncRetryableError(reasonCode);
}
