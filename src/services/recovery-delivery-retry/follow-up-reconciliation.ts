import { Prisma, type PrismaClient } from "@prisma/client";
import { createLogger, type StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { followUpRetryAttemptId, FOLLOW_UP_RETRY_BLOCK_PREFIX } from "../../domain/recovery-follow-up-retry-allowance.js";
import { classifyFollowUpRetryOpening } from "../../domain/recovery-follow-up-retry-outcome.js";
import { lockRecoveryContext, terminalRecovery } from "../recovery-conversation/recovery-conversation.sql.js";
import { notifyAllowanceBoundary, allowanceUsage } from "../recovery-allowance/storage.js";
import { findExactRecoveryReservationSource } from "../recovery-delivery-compensation/lineage.js";
import { readCommittedRecoveryUsage } from "../recovery-delivery-compensation/committed-usage.js";
import { RecoveryDeliveryCompensationService } from "../recovery-delivery-compensation/reconcile.service.js";
import { readExactAutomatedUsage, removeExactAutomatedUsage } from "../recovery-delivery-compensation/automated-usage.js";
import { releaseReservedSource } from "../recovery-delivery-compensation/reserved.js";
import { requireLineage, RecoveryCompensationLineageError, type RecoverySource } from "../recovery-delivery-compensation/types.js";
import { freeRecoveryReservationService } from "../free-recovery-reservation.service.js";
import { purchasedRecoveryReservationService } from "../purchased-recovery-reservation.service.js";
import { paidIncludedRecoveryReservationService } from "../paid-included-recovery-reservation.service.js";
import { promotionalRecoveryReservationService } from "../promotional-recovery-reservation.service.js";
import { hasLocalNoContact } from "../whatsapp-contact-opt-out/local-no-contact.js";
import { scheduledFollowUpRetryClaimKey } from "./follow-up-eligibility.js";
import { followUpRetryDispatchKey } from "./follow-up-permit.js";
import { readRetryFundingLineage } from "./funding-lineage.js";
import { initialOutreachDiagnostic } from "./error-diagnostic.js";
import { isReplayableRecoveryTransactionError, recoveryTransactionBackoffMs, transactionFailureDetails, waitForRecoveryTransactionReplay } from "./transaction-resilience.js";

const logger = createLogger({ serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName() });
type Tx = Prisma.TransactionClient;
type Database = Pick<PrismaClient, "$transaction" | "conversationAllowanceBlock">;
type Result = { kind: "held" | "ready" | "unchanged"; reason: string } |
  { kind: "settled" | "cancelled"; reservationId: string } |
  { kind: "compensated"; messageId: string; disposition: string };
type LockedResult = Exclude<Result, { kind: "compensated" }> | { kind: "provider-failure"; messageId: string };
const held = (reason: string): LockedResult => ({ kind: "held", reason });
const clearedRepair = { repairAt: null, repairLeaseToken: null, repairLeaseUntil: null } as const;

/** Dedicated, SQL-only owner for funded follow-up retry blocks. Legacy repair
 * must continue to exclude these IDs. The sweep reconciles existing blocks; a
 * prepared result is not permission to send. Positive evidence is settled
 * before checking current eligibility; a terminal checkout cannot undo a send. */
export class ScheduledFollowUpRetryReconciliationService {
  constructor(private readonly db: Database, private readonly clock: () => Date = () => new Date(),
    private readonly log: StructuredLogger = logger) {}

  async reconcile(blockId: string): Promise<Result> {
    const attemptId = followUpRetryAttemptId(blockId);
    if (!attemptId) return { kind: "held", reason: "invalid-retry-block" };
    const fields = { allowanceBlockId: blockId, outreachAttemptId: attemptId, retryIntentId: attemptId.slice("retry_".length) };
    for (let n = 1; n <= 3; n++) {
      try {
        const outcome = await this.db.$transaction(tx => this.locked(tx, blockId, attemptId),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        // The existing provider-failure compensation transaction locks and
        // rereads the message and exact source. Do not nest it or bypass its
        // idempotent correction and retry-intent creation logic.
        const result: Result = outcome.kind === "provider-failure"
          ? await this.compensate(outcome.messageId) : outcome;
        if (result.kind === "settled" || result.kind === "cancelled" || result.kind === "compensated")
          this.log.info("recovery.delivery_retry.follow_up_reconciled", { ...fields, ...result });
        else this.log.debug("recovery.delivery_retry.follow_up_reconciliation_held", { ...fields, ...result });
        return result;
      } catch (error) {
        const evidence = { ...fields, transactionAttempt: n, ...transactionFailureDetails(error), sourceError: initialOutreachDiagnostic(error) };
        if (error instanceof RecoveryCompensationLineageError) {
          this.log.warn("recovery.delivery_retry.follow_up_reconciliation_conflict", evidence);
          return { kind: "held", reason: "reconciliation-lineage-conflict" };
        }
        if (n < 3 && isReplayableRecoveryTransactionError(error)) {
          const retryBackoffMs = recoveryTransactionBackoffMs(n, error);
          this.log.warn("recovery.delivery_retry.follow_up_reconciliation_retry", { ...evidence, retryBackoffMs });
          await waitForRecoveryTransactionReplay(retryBackoffMs);
          continue;
        }
        this.log.error("recovery.delivery_retry.follow_up_reconciliation_failed", evidence);
        throw error;
      }
    }
    throw new Error("Unreachable follow-up reconciliation state");
  }

  /** Include unknown admitted outcomes even after their repair deadline. Scan
   * by immutable ID so one unresolved provider request cannot starve others. */
  async reconcilePage(input: { limit: number; afterId?: string }) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 250 || input.afterId === "")
      throw new RangeError("Invalid follow-up retry reconciliation page");
    const blocks = await this.db.conversationAllowanceBlock.findMany({ where: { state: "PENDING",
      id: { startsWith: FOLLOW_UP_RETRY_BLOCK_PREFIX, ...(input.afterId ? { gt: input.afterId } : {}) } },
      select: { id: true }, orderBy: { id: "asc" }, take: input.limit });
    const outcomes: Array<{ blockId: string; kind: Result["kind"] | "error" }> = [];
    for (const block of blocks) {
      try { outcomes.push({ blockId: block.id, kind: (await this.reconcile(block.id)).kind }); }
      catch (error) {
        this.log.error("recovery.delivery_retry.follow_up_reconciliation_item_failed", { allowanceBlockId: block.id, sourceError: initialOutreachDiagnostic(error) });
        outcomes.push({ blockId: block.id, kind: "error" });
      }
    }
    return { outcomes, next: blocks.length === input.limit ? blocks.at(-1)!.id : null };
  }

  private async compensate(messageId: string): Promise<Result> {
    const disposition = await new RecoveryDeliveryCompensationService(this.db, this.clock, this.log).reconcileMessage(messageId);
    if (disposition === "purchased-compensation-required") return { kind: "held", reason: "provider-failure-compensation-deferred" };
    return disposition === "not-terminal" || disposition === "not-recovery"
      ? { kind: "held", reason: "provider-failure-evidence-changed" }
      : { kind: "compensated", messageId, disposition };
  }

  private async locked(tx: Tx, blockId: string, attemptId: string): Promise<LockedResult> {
    const pointer = await tx.conversationAllowanceBlock.findUnique({ where: { id: blockId } });
    if (!pointer) return held("block-missing");
    const owner = await lockRecoveryContext(tx, pointer.conversationId);
    if (!owner || owner.shopId !== pointer.shopId) return held("owner-mismatch");
    const block = await tx.conversationAllowanceBlock.findUniqueOrThrow({ where: { id: blockId } });
    if (block.state !== "PENDING") return { kind: "unchanged", reason: `block-${block.state.toLowerCase()}` };
    if (block.shopId !== owner.shopId || block.conversationId !== owner.id || block.fundingKind !== "FOLLOW_UP" ||
        !block.creditReservationId || !block.predecessorId || !block.repairDeadlineAt || block.repairLeaseToken || block.repairLeaseUntil)
      return held("block-ownership-conflict");
    const recoveryRows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM commerce."CheckoutRecovery" WHERE id=${owner.recoveryId} FOR UPDATE`;
    if (recoveryRows.length !== 1) return held("recovery-missing");
    const recovery = await tx.checkoutRecovery.findUniqueOrThrow({ where: { id: owner.recoveryId }, select: {
      shopId: true, checkoutToken: true, generation: true, lastExternalActivityAt: true, status: true, completedAt: true, expiredAt: true,
      shop: { select: { platform: true } },
    } });
    const attempt = await tx.recoveryOutreachAttempt.findUnique({ where: { id: attemptId } });
    const intentId = attemptId.slice("retry_".length);
    if (!attempt || attempt.checkoutRecoveryId !== owner.recoveryId || attempt.sequence < 3 || attempt.trigger !== "NO_RESPONSE_FOLLOW_UP" ||
        attempt.initiatedBy !== "AUTOMATION" || attempt.initiationKey !== scheduledFollowUpRetryClaimKey(intentId) || !attempt.claimedAt ||
        recovery.shopId !== owner.shopId || !["SHOPIFY", "WOOCOMMERCE"].includes(recovery.shop.platform)) return held("attempt-ownership-conflict");
    const predecessor = await tx.conversationAllowanceBlock.findUnique({ where: { id: block.predecessorId } });
    if (!predecessor || predecessor.conversationId !== owner.id || predecessor.shopId !== owner.shopId ||
        predecessor.fundingKind !== "INITIAL" || predecessor.ordinal !== 0 || !["ACTIVE", "EXHAUSTED", "CLOSED"].includes(predecessor.state))
      return held("predecessor-block-conflict");
    const links = await readRetryFundingLineage(tx, { recoveryId: owner.recoveryId, conversationId: owner.id, attemptId });
    const intent = await tx.recoveryOutreachRetryIntent.findUnique({ where: { id: intentId } });
    if (!intent || intent.id !== links.at(-1)?.intent.id) return held("intent-ownership-conflict");
    const source = await findExactRecoveryReservationSource(tx, owner.shopId, attemptId);
    if (!source || source.reservation.id !== block.creditReservationId || source.reservation.quantity !== 1 ||
        source.reservation.compensationUsageEventId || source.reservation.compensationReason || source.reservation.compensationDisposition || source.reservation.compensatedAt)
      return held("reservation-ownership-conflict");
    const messages = await tx.conversationMessage.findMany({ where: { allowanceBlockId: block.id }, select: { id: true }, take: 2 });
    if (messages.length > 1) return held("multiple-opening-messages");
    const messageId = messages[0]?.id;
    if (messageId) await tx.$queryRaw`SELECT id FROM whatsapp."ConversationMessage" WHERE id=${messageId} FOR UPDATE`;
    const message = messageId ? await tx.conversationMessage.findUnique({ where: { id: messageId }, include: {
      recoveryOutreachAttempt: { select: { id: true } }, merchantSendCommand: { select: { id: true } }, _count: { select: { deliveryParts: true } },
    } }) : null;
    if ((messageId && !message) || (attempt.outboundMessageId && attempt.outboundMessageId !== messageId) ||
        (message && (message.allowanceBlockId !== block.id || message.conversationId !== owner.id || message.direction !== "OUTBOUND" ||
          message.senderType !== "AUTOMATION" || message.merchantSendCommand || message._count.deliveryParts || message.inReplyToProviderId ||
          message.outboundPresentation !== null || (message.recoveryOutreachAttempt && message.recoveryOutreachAttempt.id !== attemptId)))) return held("opening-ownership-conflict");
    const usage = await tx.usageEvent.findUnique({ where: { idempotencyKey: `recovery-outreach:${attemptId}` } });
    const exact = message ? await readExactAutomatedUsage(tx, owner.shopId, message.id) : null;
    if ((usage && (!message || usage.sourceId !== message.id || usage.shopId !== owner.shopId || usage.metric !== "OUTBOUND_AUTOMATED_MESSAGE" ||
        usage.sourceType !== "OUTBOUND_AUTOMATED_MESSAGE" || usage.provider !== recovery.shop.platform || Number(usage.quantity) !== 1 || exact?.id !== usage.id)) || (!usage && exact))
      return held("opening-usage-conflict");
    const dispatchKey = followUpRetryDispatchKey(attemptId);
    const keyOwner = await tx.conversationMessage.findUnique({ where: { providerDispatchKey: dispatchKey }, select: { id: true } });
    if (keyOwner && keyOwner.id !== messageId) return held("provider-permit-conflict");
    const terminalFailure = attempt.status === "FAILED" && attempt.outboundMessageId === messageId ? attempt.failureCode : null;
    const evidence = classifyFollowUpRetryOpening(message, dispatchKey, terminalFailure);
    if (evidence === "conflict" || evidence === "unknown") return held(`opening-${evidence}`);
    // Compare historical dispatch stamps, not the current allocation route;
    // a released or drained sender cannot invalidate a provider acceptance.
    if (message?.providerDispatchKey) {
      const history = await tx.conversationMessage.findMany({ where: { id: { in: links.map(link => link.intent.failedMessageId) } },
        select: { dispatchProviderAccountId: true, dispatchProviderPhoneNumberId: true } });
      if (history.length !== links.length || history.some(m => m.dispatchProviderAccountId !== message.dispatchProviderAccountId ||
          m.dispatchProviderPhoneNumberId !== message.dispatchProviderPhoneNumberId)) return held("provider-sender-conflict");
    }
    const now = this.clock();
    const terminal = terminalRecovery(recovery.status) || !!recovery.completedAt || !!recovery.expiredAt;
    if (evidence === "non-delivery") {
      if (!message || (!usage && attempt.outboundMessageId !== message.id) || !["RESERVED", "AMBIGUOUS", "COMMITTED", "RELEASED"].includes(source.reservation.status)) return held("failure-identity-unproven");
      return { kind: "provider-failure", messageId: message.id };
    }
    if (evidence === "accepted") {
      // If a positive receipt won the race before compensation, settle that
      // still-pending source. A previously compensated/cancelled block is
      // never reopened; the original failure timestamps stay on the message.
      const latePositive = attempt.status === "FAILED" && !!message?.failedAt &&
        (message.status === "DELIVERED" || message.status === "READ") && !!attempt.failureCode &&
        (attempt.failureCode === "WHATSAPP_RECIPIENT_UNDELIVERABLE" || attempt.failureCode.startsWith("WHATSAPP_DELIVERY_FAILED")) &&
        !await tx.recoveryOutreachRetryIntent.findUnique({ where: { failedAttemptId: attemptId }, select: { id: true } });
      if (!message?.sentAt || !usage || (attempt.sentAt && attempt.sentAt.getTime() !== message.sentAt.getTime()) ||
          (!latePositive && !["PENDING", "WAITING_FOR_RESPONSE", "ENGAGED", "CANCELLED", "NO_RESPONSE"].includes(attempt.status))) return held("accepted-opening-conflict");
      await commitAcceptedSource(tx, source, message.sentAt);
      const settled = await findExactRecoveryReservationSource(tx, owner.shopId, attemptId);
      requireLineage(settled?.reservation.status === "COMMITTED" && settled.reservation.id === source.reservation.id, "follow-up retry commitment missing");
      const committed = await readCommittedRecoveryUsage(tx, settled);
      requireLineage(committed.provider === recovery.shop.platform, "follow-up retry commitment provider mismatch");
      const inbound = owner.lastInboundAt && owner.lastInboundAt >= message.sentAt ? owner.lastInboundAt : null;
      await tx.recoveryOutreachAttempt.update({ where: { id: attemptId }, data: { outboundMessageId: message.id, sentAt: message.sentAt,
        ...(attempt.status === "PENDING" || attempt.status === "WAITING_FOR_RESPONSE" || latePositive ? {
          status: terminal ? "CANCELLED" : inbound ? "ENGAGED" : "WAITING_FOR_RESPONSE",
          ...(latePositive ? { failureCode: null, closedAt: null } : {}),
          ...(terminal ? { closedAt: now } : inbound ? { customerRespondedAt: inbound } : {}),
        } : {}), followUpDueAt: null } });
      await tx.conversationAllowanceBlock.updateMany({ where: { id: predecessor.id, state: { in: ["ACTIVE", "EXHAUSTED"] } }, data: { state: "CLOSED" } });
      const activated = await tx.conversationAllowanceBlock.update({ where: { id: blockId }, data: { state: terminal ? "CLOSED" : "ACTIVE", ...clearedRepair } });
      if (activated.state === "ACTIVE" && await allowanceUsage(tx, activated) >= activated.hardMessageLimit - activated.terminalReservedSlots)
        await notifyAllowanceBoundary(tx, activated, now);
      return { kind: "settled", reservationId: source.reservation.id };
    }
    // Only exact pre-provider evidence or an explicit synchronous rejection
    // may release a reservation; never use deadline/STOP to release a permit.
    if (attempt.sentAt || attempt.customerRespondedAt) return held("attempt-progress-conflict");
    if (await tx.recoveryOutreachRetryIntent.findUnique({ where: { failedAttemptId: attemptId }, select: { id: true } })) return held("successor-intent-exists");
    const obsolete = !!intent.cancelledAt || terminal || recovery.status === "ENGAGED" || owner.inboundVersion > 0 || !!owner.lastInboundAt ||
      intent.expectedGeneration !== recovery.generation || intent.expectedLastExternalActivityAt.getTime() !== recovery.lastExternalActivityAt.getTime() ||
      block.repairDeadlineAt <= now || !!await tx.conversationMessage.findFirst({ where: { conversationId: owner.id, direction: "INBOUND", senderType: "CUSTOMER" }, select: { id: true } }) || await hasLocalNoContact(tx, { shopId: owner.shopId, recipient: attempt.recipient }) ||
      !!await tx.checkoutRecovery.findFirst({ where: { shopId: owner.shopId, checkoutToken: recovery.checkoutToken, generation: { gt: recovery.generation } }, select: { id: true } });
    if (evidence !== "rejected" && evidence !== "refused" && !obsolete) {
      if (attempt.status !== "PENDING" || attempt.outboundMessageId || attempt.closedAt || attempt.failureCode || attempt.followUpDueAt ||
          source.reservation.status !== "RESERVED" || source.reservation.releaseReason || source.reservation.committedUsageEventId ||
          (source.reservation.expiresAt && source.reservation.expiresAt <= now) || (message && !usage)) return held("prepared-funding-conflict");
      return { kind: "ready", reason: evidence };
    }
    if (!["PENDING", "FAILED", "CANCELLED"].includes(attempt.status) || !["RESERVED", "RELEASED"].includes(source.reservation.status) ||
        source.reservation.committedUsageEventId || (!message && usage)) return held("release-evidence-conflict");
    if (message) {
      if (!usage && attempt.outboundMessageId !== message.id) return held("release-usage-unproven");
      if (message.status !== "FAILED") await tx.conversationMessage.update({ where: { id: message.id }, data: { status: "FAILED" } });
      await removeExactAutomatedUsage(tx, owner.shopId, message.id, exact);
    }
    if (source.reservation.status === "RESERVED") await releaseReservedSource(tx, source);
    await tx.recoveryOutreachAttempt.update({ where: { id: attemptId }, data: { status: message ? "FAILED" : "CANCELLED", closedAt: attempt.closedAt ?? now,
      ...(message ? { outboundMessageId: message.id, failureCode: evidence === "rejected" ? "PROVIDER_REJECTED" : "PRE_PROVIDER_REFUSED" } : {}), followUpDueAt: null } });
    if (!intent.cancelledAt) await tx.recoveryOutreachRetryIntent.update({ where: { id: intentId }, data: { cancelledAt: now } });
    await tx.conversationAllowanceBlock.update({ where: { id: blockId }, data: { state: "CANCELLED", ...clearedRepair } });
    return { kind: "cancelled", reservationId: source.reservation.id };
  }
}

async function commitAcceptedSource(tx: Tx, source: RecoverySource, occurredAt: Date) {
  const r = source.reservation;
  if (r.status === "COMMITTED") return;
  requireLineage(["RESERVED", "AMBIGUOUS"].includes(r.status) && !r.committedUsageEventId && !r.releaseReason, "accepted retry source cannot be committed");
  if (r.status === "AMBIGUOUS") {
    // Same normalization as definitive provider failure compensation: the
    // reserved capacity remains held. Only exact positive evidence permits it.
    const normalized = await tx.usageReservation.updateMany({ where: { id: r.id, status: "AMBIGUOUS", committedUsageEventId: null,
      compensationUsageEventId: null }, data: { status: "RESERVED" } });
    requireLineage(normalized.count === 1, "ambiguous accepted retry source changed");
  }
  const input = { shopId: r.shopId, sourceKey: r.sourceKey, quantity: 1 };
  const result = source.kind === "free" ? await freeRecoveryReservationService.commitInExistingTransaction(tx, input)
    : source.kind === "purchased" ? await purchasedRecoveryReservationService.commitInExistingTransaction(tx, input)
    : source.kind === "paid" ? await paidIncludedRecoveryReservationService.commitInExistingTransaction(tx, { ...input, occurredAt })
    : await promotionalRecoveryReservationService.commitInExistingTransaction(tx, input);
  requireLineage(result.kind === "committed" || result.kind === "already-committed", "follow-up retry source owner did not commit");
}
