import {
  first,
  type RecoveryContext,
  type SqlTransaction,
} from "./recovery-conversation.sql.js";
import type { StoredRecoveryConsentSnapshot } from "./recovery-stored-consent.service.js";
import { canonicalWhatsAppSender } from "../whatsapp-contact-opt-out/phone.js";
import {
  confirmCurrentWooConsent,
  confirmUniqueWooRecipient,
} from "../woocommerce-recovery/woo-recovery-admission-evidence.js";

/** Shop and Conversation are already locked by OutboundSendFenceService.
 * No HTTP or Redis reads. A preflight snapshot is not a provider permit. */
export async function checkFinalWooStoredRecoveryConsent(
  tx: SqlTransaction,
  context: RecoveryContext,
  recipient: string,
  snapshot: StoredRecoveryConsentSnapshot | undefined,
): Promise<string | null> {
  if (!snapshot?.woo) return "stored-consent-snapshot-missing";
  const woo = snapshot.woo;
  const canonical = canonicalWhatsAppSender(recipient);
  if (
    !canonical ||
    canonical !== snapshot.canonicalRecipient ||
    canonical !== woo.canonicalRecipient ||
    woo.shopId !== context.shopId ||
    woo.customerPhoneId !== snapshot.customerPhoneId ||
    woo.consentRevision !== snapshot.consentRevision ||
    woo.noContactRevision !== snapshot.noContactRevision
  )
    return "recipient-changed";
  // Recheck the recovery's current customer, not merely a phone belonging to
  // the same merchant. Keep the recovery row stable until permit commit.
  const recovery = await first<{
    customerId: string | null;
    status: string;
    completedAt: Date | null;
    expiredAt: Date | null;
  }>(
    tx,
    `
    SELECT "customerId", "status"::text, "completedAt", "expiredAt"
    FROM "commerce"."CheckoutRecovery"
    WHERE "id"=$1 AND "shopId"=$2 FOR SHARE`,
    context.recoveryId,
    context.shopId,
  );
  if (!recovery || recovery.customerId !== woo.customerId)
    return "recipient-changed";
  if (
    ["COMPLETED", "EXPIRED", "CANCELLED"].includes(recovery.status) ||
    recovery.completedAt ||
    recovery.expiredAt
  )
    return "terminal-recovery";
  const terminal = await first<{ id: string }>(
    tx,
    `
    SELECT "id" FROM "commerce"."CheckoutRecoveryStatusHistory"
    WHERE "checkoutRecoveryId"=$1 AND "source"='woocommerce.order' LIMIT 1`,
    context.recoveryId,
  );
  if (terminal) return "woo-observed-order-terminal";
  if (!(await confirmCurrentWooConsent(tx, context.shopId, woo, undefined)))
    return "woo-consent-changed";
  if (!(await confirmUniqueWooRecipient(tx, context.shopId, woo)))
    return "woo-recipient-ambiguous";
  return null;
}
