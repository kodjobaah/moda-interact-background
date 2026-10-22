import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import type { UsageReservation } from "@prisma/client";
import { requireLineage, type CompensationTransaction, type RecoverySource, type RecoverySourceKind } from "./types.js";

export type FailedOutbound = {
  id: string;
  conversationId: string;
  senderType: string;
  conversation: {
    shopId: string | null;
    checkoutRecovery: { id: string; shopId: string } | null;
  };
};

export type AutomatedUsage = {
  id: string;
  shopId: string;
  idempotencyKey: string;
  sourceType: string | null;
};

/** Use only immutable provider-message, attempt and send-admission evidence. */
export async function resolveExactRecoverySource(
  tx: CompensationTransaction,
  message: FailedOutbound,
  shopId: string,
  automatedUsage: AutomatedUsage | null,
): Promise<RecoverySource | null> {
  const recovery = message.conversation.checkoutRecovery;
  if (!recovery) return null;
  requireLineage(recovery.shopId === shopId, "conversation/recovery shop mismatch");

  const command = await tx.merchantConversationSendCommand.findUnique({
    where: { outboundMessageId: message.id },
    select: { kind: true, shopId: true, conversationId: true, recoveryOutreachAttemptId: true },
  });
  if (command) {
    requireLineage(command.shopId === shopId && command.conversationId === message.conversationId,
      "merchant command shop/conversation mismatch");
  }

  let attemptId: string | null = null;
  if (message.senderType === "HUMAN") {
    if (!command || command.kind === "HUMAN_TEXT") return null;
    requireLineage(command.kind === "RECOVERY_FOLLOW_UP_TEMPLATE" &&
      !!command.recoveryOutreachAttemptId, "human recovery-template attempt missing");
    attemptId = command.recoveryOutreachAttemptId;
  } else if (message.senderType === "AUTOMATION") {
    requireLineage(!command, "automated recovery has a human command");
    if (automatedUsage?.sourceType === "OUTBOUND_AUTOMATED_MESSAGE") {
      const match = /^recovery-outreach:([A-Za-z0-9_-]+)$/.exec(automatedUsage.idempotencyKey);
      attemptId = match?.[1] ?? null;
    }
  } else {
    return null; // AGENT conversations and ordinary human text never consume recovery credits.
  }

  const byMessage = await tx.recoveryOutreachAttempt.findUnique({
    where: { outboundMessageId: message.id },
    select: { id: true, checkoutRecoveryId: true, outboundMessageId: true, sequence: true },
  });
  if (byMessage) {
    requireLineage(!attemptId || attemptId === byMessage.id, "conflicting attempt identity");
    attemptId = byMessage.id;
  }
  if (!attemptId) return null;

  const attempt = await tx.recoveryOutreachAttempt.findUnique({
    where: { id: attemptId },
    select: { id: true, checkoutRecoveryId: true, outboundMessageId: true, sequence: true },
  });
  requireLineage(attempt && attempt.checkoutRecoveryId === recovery.id &&
    (attempt.sequence === 1 || attempt.sequence === 2) &&
    (!attempt.outboundMessageId || attempt.outboundMessageId === message.id),
    "attempt/recovery/message mismatch");
  if (message.senderType === "HUMAN") {
    requireLineage(attempt.sequence === 2 && command?.recoveryOutreachAttemptId === attempt.id,
      "human follow-up is not sequence two");
  }
  if (message.senderType === "AUTOMATION" && attempt.outboundMessageId === null) {
    requireLineage(automatedUsage?.idempotencyKey === `recovery-outreach:${attempt.id}`,
      "unlinked automated recovery message");
  }

  const logicalSource = createRecoveryIdempotencyKey(shopId, `recovery-outreach:${attempt.id}`);
  const reservations = await tx.usageReservation.findMany({
    where: { OR: [
      { sourceKey: logicalSource },
      { sourceKey: { startsWith: "paid-included:", endsWith: `:${logicalSource}` } },
    ] },
    take: 2,
  });
  requireLineage(reservations.length === 1, "missing or ambiguous reservation");
  const reservation = reservations[0]!;
  requireLineage(reservation.shopId === shopId && reservation.quantity === 1,
    "reservation shop/quantity mismatch");
  const kind = sourceKind(reservation);
  if (kind === "free" || kind === "purchased") {
    const counter = await tx.shopEntitlementCounter.findUnique({
      where: { id: reservation.counterId! },
      select: { shopId: true, counter: true },
    });
    requireLineage(counter?.shopId === shopId &&
      counter.counter === (kind === "free" ? "LIFETIME_FREE_RECOVERY_CREDITS" : "PURCHASED_RECOVERY_CREDITS"),
      "source-owned Shop credit counter mismatch");
  }
  if (kind === "paid") {
    const periodCounter = await tx.billingPeriodEntitlementCounter.findUnique({
      where: { id: reservation.billingPeriodEntitlementCounterId! },
      select: { shopId: true, billingPeriodId: true, counter: true },
    });
    requireLineage(periodCounter?.shopId === shopId &&
      periodCounter.counter === "INCLUDED_RECOVERY_CREDITS" &&
      reservation.sourceKey === `paid-included:${periodCounter.billingPeriodId}:${logicalSource}`,
      "paid included period/source mismatch");
  } else {
    requireLineage(reservation.sourceKey === logicalSource, "unexpected source key");
  }
  return { reservation, kind };
}

function sourceKind(source: UsageReservation): RecoverySourceKind {
  const count = [source.counterId, source.billingPeriodEntitlementCounterId,
    source.purchasedCreditPurchaseId, source.promotionalCreditGrantId].filter(Boolean).length;
  // Purchased reservations have both a counter AND an immutable purchase-lot FK.
  requireLineage(count === (source.purchasedCreditPurchaseId ? 2 : 1),
    "reservation has invalid source ownership");
  if (source.purchasedCreditPurchaseId) {
    requireLineage(!!source.counterId, "purchased source counter missing");
    return "purchased";
  }
  if (source.billingPeriodEntitlementCounterId) return "paid";
  if (source.promotionalCreditGrantId) return "promotional";
  requireLineage(!!source.counterId, "free source counter missing");
  return "free";
}
