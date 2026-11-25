import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import type { UsageReservation } from "@prisma/client";
import { outreachDeliveryFailureCode } from "../../domain/whatsapp-recipient-failure.js";
import { requireLineage, type CompensationTransaction, type RecoverySource, type RecoverySourceKind } from "./types.js";

export type FailedOutbound = {
  id: string;
  conversationId: string;
  senderType: string;
  sentAt: Date | null;
  failedAt: Date | null;
  providerFailureCode: string | null;
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

  const pinned = await tx.conversationMessage.findUnique({where:{id:message.id},select:{allowanceBlockId:true}});
  if(pinned?.allowanceBlockId){
    const block=await tx.conversationAllowanceBlock.findUnique({where:{id:pinned.allowanceBlockId}});
    requireLineage(block && block.shopId===shopId && block.conversationId===message.conversationId,"allowance owner mismatch");
    const opening=await tx.conversationMessage.findFirst({where:{allowanceBlockId:block!.id,direction:"OUTBOUND"},orderBy:[{createdAt:"asc"},{id:"asc"}],select:{id:true}});
    if(opening?.id!==message.id)return null;
    // A late opener failure cannot undo credit already funding another permit.
    const consumed=await tx.conversationMessage.findFirst({where:{allowanceBlockId:block!.id,id:{not:message.id},OR:[{providerDispatchKey:{not:null}},{providerDispatchAdmittedAt:{not:null}},{providerMessageId:{not:null}},{sentAt:{not:null}}]},select:{id:true}});
    requireLineage(!consumed,"late allowance opening failure after other provider-admitted consumption");
    if(block!.fundingKind==="CONTINUATION"){
      const source=await findExactReservationSource(tx,shopId,createRecoveryIdempotencyKey(shopId,`recovery-continuation:${block!.id}`));
      requireLineage(source&&source.reservation.id===block!.creditReservationId,"continuation reservation mismatch");
      return source;
    }
  }

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
    select: { id: true, checkoutRecoveryId: true, outboundMessageId: true, sequence: true, status: true, sentAt: true },
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

  const source = await findExactRecoveryReservationSource(tx, shopId, attempt.id);
  requireLineage(source, "missing or ambiguous reservation");
  // A failure may arrive before finalization links the outbound message. The
  // exact admission key (or verified merchant command) proves that identity.
  // Preserve it before deleting the hard-limit usage row; otherwise replays
  // could lose the source and an old attempt key could admit a duplicate send.
  const close = ["PENDING", "CAPACITY_BLOCKED", "WAITING_FOR_RESPONSE"].includes(attempt.status);
  if (!attempt.outboundMessageId || close) {
    requireLineage(message.failedAt, "failed recovery message lacks failure timestamp");
    requireLineage(!attempt.sentAt || (message.sentAt && attempt.sentAt.getTime() === message.sentAt.getTime()),
      "attempt/message sent timestamp mismatch");
    const changed = await tx.recoveryOutreachAttempt.updateMany({
      where: { id: attempt.id, checkoutRecoveryId: recovery.id, status: attempt.status,
        outboundMessageId: attempt.outboundMessageId },
      data: { outboundMessageId: message.id,
        ...(message.sentAt && !attempt.sentAt ? { sentAt: message.sentAt } : {}),
        ...(close ? { status: "FAILED" as const, failureCode: outreachDeliveryFailureCode(message.providerFailureCode),
          followUpDueAt: null, closedAt: message.failedAt } : {}) },
    });
    requireLineage(changed.count === 1, "failed recovery attempt convergence conflict");
  }
  return source;
}

export async function findExactRecoveryReservationSource(
  tx: CompensationTransaction,
  shopId: string,
  outreachAttemptId: string,
): Promise<RecoverySource | null> {
  return findExactReservationSource(tx, shopId, createRecoveryIdempotencyKey(shopId, `recovery-outreach:${outreachAttemptId}`));
}

/** One canonical source reader for every funded recovery action; never infer from today's plan. */
export async function findExactReservationSource(tx: CompensationTransaction, shopId: string, logicalSource: string): Promise<RecoverySource | null> {
  const reservations = await tx.usageReservation.findMany({
    where: { OR: [
      { sourceKey: logicalSource },
      { sourceKey: { startsWith: "paid-included:", endsWith: `:${logicalSource}` } },
    ] },
    take: 2,
  });
  requireLineage(reservations.length <= 1, "missing or ambiguous reservation");
  if (reservations.length === 0) return null;

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
  if (kind === "purchased") {
    const purchase = await tx.recoveryCreditPurchase.findUnique({
      where: { id: reservation.purchasedCreditPurchaseId! },
      select: { shopId: true },
    });
    requireLineage(purchase?.shopId === shopId, "purchased lot Shop mismatch");
  }
  if (kind === "promotional") {
    const grant = await tx.promotionalCreditGrant.findUnique({
      where: { id: reservation.promotionalCreditGrantId! },
      select: { shopId: true },
    });
    requireLineage(grant?.shopId === shopId, "promotional grant Shop mismatch");
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
  if (source.purchasedCreditPurchaseId) {
    requireLineage(!!source.counterId && !source.billingPeriodEntitlementCounterId &&
      !source.promotionalCreditGrantId, "reservation has invalid purchased ownership");
    return "purchased";
  }
  if (source.billingPeriodEntitlementCounterId) {
    requireLineage(!source.counterId && !source.promotionalCreditGrantId,
      "reservation has invalid paid ownership");
    return "paid";
  }
  if (source.promotionalCreditGrantId) {
    requireLineage(!source.counterId, "reservation has invalid promotional ownership");
    return "promotional";
  }
  requireLineage(!!source.counterId, "free source counter missing");
  return "free";
}
