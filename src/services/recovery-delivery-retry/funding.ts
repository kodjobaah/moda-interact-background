import type { RetryFundingLink } from "../../domain/recovery-retry-funding-lineage.js";
import { decideRecoveryOutreachRetry, isValidRecoveryDeliveryRetryConfig } from "../../domain/recovery-outreach-retry-policy.js";
import { findExactRecoveryReservationSource } from "../recovery-delivery-compensation/lineage.js";
import { readCommittedCorrectionReplay } from "../recovery-delivery-compensation/committed-usage.js";
import { requireLineage, type CompensationTransaction } from "../recovery-delivery-compensation/types.js";
import { hasLocalNoContact } from "../whatsapp-contact-opt-out/local-no-contact.js";
import { requireCurrentInitialRetry } from "./funding-lineage.js";

/** An intent alone is not funding evidence. Prove every historical source
 * from its own attempt key and its immutable release/correction before
 * treating that history as reusable capacity. A historical-only or held-for-
 * refund correction does not grant capacity; ordinary billing still decides
 * whether a new credit is available.
 */
export async function verifyRetryPredecessorFunding(tx: CompensationTransaction, shopId: string, links: readonly RetryFundingLink[]): Promise<void> {
  for (const { predecessor, intent } of links) {
    const source = await findExactRecoveryReservationSource(tx, shopId, predecessor.id);
    requireLineage(source && source.reservation.id === intent.fundingReservationId,
      "retry predecessor reservation mismatch");
    const reservation = source.reservation;
    if (reservation.status === "COMMITTED") {
      await readCommittedCorrectionReplay(tx, source);
    } else {
      requireLineage(reservation.status === "RELEASED" && !reservation.committedUsageEventId &&
        !reservation.compensationUsageEventId && !reservation.compensationReason &&
        !reservation.compensationDisposition && !reservation.compensatedAt,
      "retry predecessor funding is not released or corrected");
    }
  }
}

/** Funding preflight for an already-created, currently selected initial retry.
 * Called under the existing recovery owner lock. This does not claim an intent,
 * reserve capacity or authorize dispatch. The dispatcher must additionally
 * revalidate checkout lifetime, consent, sender and final provider admission.
 * Only AFTER_COOLDOWN is actionable here; policy/repair/review holds are inert.
 */
export async function requireInitialRetryFundingReady(tx: CompensationTransaction, input: {
  shopId: string; recoveryId: string; conversationId: string; attemptId: string; now: Date;
}): Promise<readonly RetryFundingLink[]> {
  const links = await requireCurrentInitialRetry(tx, input);
  const latest = links.at(-1)!;
  const intent = await tx.recoveryOutreachRetryIntent.findUnique({ where: { id: latest.intent.id } });
  const recovery = await tx.checkoutRecovery.findUnique({ where: { id: input.recoveryId }, select: {
    shopId: true, generation: true, lastExternalActivityAt: true,
  } });
  const config = await tx.backgroundRuntimeConfig.findUnique({ where: { id: "default" }, select: {
    recoveryDeliveryTemporaryRetryDelayMinutes: true,
    recoveryDeliveryRateLimitRetryDelayMinutes: true,
    recoveryDeliveryMarketingRetryDelayMinutes: true,
    recoveryDeliveryMaxRetries: true,
  } });
  requireLineage(recovery?.shopId === input.shopId && intent && !intent.cancelledAt &&
    intent.expectedGeneration === recovery.generation &&
    intent.expectedLastExternalActivityAt.getTime() === recovery.lastExternalActivityAt.getTime() &&
    intent.policy === "AFTER_COOLDOWN" && intent.notBeforeAt &&
    isValidRecoveryDeliveryRetryConfig(config) && links.length <= config.recoveryDeliveryMaxRetries,
  "initial retry policy, generation or budget is held");
  const failedMessage = await tx.conversationMessage.findUnique({
    where: { id: latest.intent.failedMessageId }, select: { providerFailureCode: true },
  });
  requireLineage(failedMessage && failedMessage.providerFailureCode === intent.providerFailureCode,
    "retry predecessor failure code mismatch");
  requireLineage(!await hasLocalNoContact(tx, { shopId: input.shopId, recipient: latest.predecessor.recipient }),
    "initial retry local contact restriction");
  requireLineage(!await tx.conversationMessage.findFirst({
    where: { conversationId: input.conversationId, direction: "INBOUND", senderType: "CUSTOMER" }, select: { id: true },
  }), "initial retry has customer history");
  const failedAt = latest.predecessor.outboundMessage?.failedAt;
  requireLineage(failedAt, "retry predecessor failure time missing");
  const currentDecision = decideRecoveryOutreachRetry(intent.providerFailureCode, failedAt, config);
  requireLineage(currentDecision.policy === "AFTER_COOLDOWN" &&
    Math.max(intent.notBeforeAt.getTime(), currentDecision.notBeforeAt.getTime()) <= input.now.getTime(),
  "initial retry cooldown is held");
  await verifyRetryPredecessorFunding(tx, input.shopId, links);
  return links;
}
