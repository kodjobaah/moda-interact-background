import { followUpRetryAttemptId, isFollowUpRetryBlock } from "../../domain/recovery-follow-up-retry-allowance.js";
import { releaseReservedSource } from "../recovery-delivery-compensation/reserved.js";
import { readExactAutomatedUsage, removeExactAutomatedUsage } from "../recovery-delivery-compensation/automated-usage.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { initialOutreachDiagnostic } from "../recovery-delivery-retry/error-diagnostic.js";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import type { ConversationAllowanceBlock, Prisma } from "@prisma/client";
import { lockRecoveryContext, readRecoveryWindowEvidence, terminalRecovery, type RecoveryContext } from "../recovery-conversation/recovery-conversation.sql.js";
import { customerWindow, CUSTOMER_WINDOW_MS } from "../recovery-conversation/recovery-follow-up-policy.service.js";
import { findExactRecoveryReservationSource, findExactReservationSource } from "../recovery-delivery-compensation/lineage.js";
import { readCommittedCorrectionReplay, readCommittedRecoveryUsage } from "../recovery-delivery-compensation/committed-usage.js";
import { hasConfirmedOutreachDelivery, selectEffectiveOutreachAttempt } from "../../domain/recovery-outreach-identity.js";
import { retryFundingLineage } from "../../domain/recovery-retry-funding-lineage.js";
import { retryFundingIdentitySelect, readRetryFundingLineage } from "../recovery-delivery-retry/funding-lineage.js";
import { verifyRetryPredecessorFunding } from "../recovery-delivery-retry/funding.js";
import { hasLocalNoContact } from "../whatsapp-contact-opt-out/local-no-contact.js";
const retryAllowanceLogger = createLogger({ serviceName: "moda-messaging-worker", environment: resolveDeploymentEnvironmentName() });
type Tx = Prisma.TransactionClient;
export type AllowanceLimits = {
    outboundHardLimit: number;
    terminalMessageReservedSlots: number;
};
export const continuationSourceId = (blockId: string) => `recovery-continuation:${blockId}`;
export const allowanceSourceKey = (shopId: string, blockId: string) => createRecoveryIdempotencyKey(shopId, continuationSourceId(blockId));
export class AllowanceHeld extends Error {
    constructor(readonly reason: string) { super(`Recovery allowance held: ${reason}`); }
}
/** Adopt the original or positively delivered initial retry. Never rebind an
 * existing allowance reservation, even if a later physical send succeeded. */
export async function adoptInitial(tx: Tx, conversationId: string, limits: AllowanceLimits): Promise<ConversationAllowanceBlock> {
    const context = await requireAllowanceOwner(tx, conversationId);
    return adoptInitialUnderOwnerLock(tx, context, limits);
}

async function requireAllowanceOwner(tx: Tx, conversationId: string): Promise<RecoveryContext> {
    const context = await lockRecoveryContext(tx, conversationId);
    if (!context)
        throw new AllowanceHeld("owner-unavailable");
    return context;
}

// Private helpers accept only a context acquired in this transaction. Keep
// the Shop -> Conversation lock until commit, but do not acquire/read it again
// at each layer. All funding and delivery evidence is still read under it.
async function adoptInitialUnderOwnerLock(tx: Tx, context: RecoveryContext, limits: AllowanceLimits): Promise<ConversationAllowanceBlock> {
    const conversationId = context.id;
    const existing = await tx.conversationAllowanceBlock.findFirst({ where: { conversationId, fundingKind: "INITIAL" } });
    const hasRetry = await tx.recoveryOutreachAttempt.findFirst({
        where: { checkoutRecoveryId: context.recoveryId, sequence: { gte: 3 }, trigger: "INITIAL" }, select: { id: true },
    });
    if (existing && !hasRetry)
        return existing;
    let initial: { id: string; outboundMessageId: string | null; sentAt: Date | null } | null;
    const retryFields: Record<string, unknown> = { shopId: context.shopId, checkoutRecoveryId: context.recoveryId, conversationId };
    try {
        if (hasRetry) {
            const attempts = await tx.recoveryOutreachAttempt.findMany({ where: { checkoutRecoveryId: context.recoveryId }, select: retryFundingIdentitySelect });
            const selection = selectEffectiveOutreachAttempt({ recoveryId: context.recoveryId, conversationId, slot: "INITIAL", attempts });
            if (selection.kind !== "selected" || selection.retryCount === 0)
                throw new AllowanceHeld("initial-retry-delivery-unproven");
            initial = selection.current;
            Object.assign(retryFields, { outreachAttemptId: initial.id, retryIntentId: initial.id.slice("retry_".length),
                sequence: selection.current.sequence, outboundMessageId: initial.outboundMessageId });
            if (!hasConfirmedOutreachDelivery(selection.current, conversationId))
                throw new AllowanceHeld("initial-retry-delivery-unproven");
            const links = retryFundingLineage({ recoveryId: context.recoveryId, conversationId, attemptId: initial.id, attempts });
            if (!links)
                throw new AllowanceHeld("initial-retry-lineage-unproven");
            await verifyRetryPredecessorFunding(tx, context.shopId, links);
        } else {
            initial = await tx.recoveryOutreachAttempt.findUnique({ where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: context.recoveryId, sequence: 1 } } });
        }
        if (!initial?.outboundMessageId || !initial.sentAt)
            throw new AllowanceHeld("original-funding-unproven");
        const message = await tx.conversationMessage.findUnique({ where: { id: initial.outboundMessageId } });
        if (!message || message.conversationId !== conversationId || !message.providerMessageId || !message.sentAt || !["SENT", "DELIVERED", "READ"].includes(message.status) || message.failedAt)
            throw new AllowanceHeld("original-receipt-unproven");
        const source = await findExactRecoveryReservationSource(tx, context.shopId, initial.id);
        if (!source || source.reservation.status !== "COMMITTED" || source.reservation.compensationUsageEventId)
            throw new AllowanceHeld("original-funding-unproven");
        await readCommittedRecoveryUsage(tx, source);
        if (existing) {
            if (existing.creditReservationId !== source.reservation.id)
                throw new AllowanceHeld("initial-retry-existing-allowance");
            if (hasRetry) retryAllowanceLogger.debug("recovery.delivery_retry.allowance_replayed", {
                ...retryFields, fundingReservationId: source.reservation.id, allowanceBlockId: existing.id,
            });
            return existing;
        }
        const block = await tx.conversationAllowanceBlock.create({ data: { id: randomUUID(), shopId: context.shopId, conversationId, ordinal: 0, fundingKind: "INITIAL", state: "ACTIVE", creditReservationId: source.reservation.id, hardMessageLimit: limits.outboundHardLimit, terminalReservedSlots: limits.terminalMessageReservedSlots } });
        // The outer owner may still roll back. Do not label this as committed.
        if (hasRetry) retryAllowanceLogger.debug("recovery.delivery_retry.allowance_adoption_prepared", {
            ...retryFields, fundingReservationId: source.reservation.id, allowanceBlockId: block.id,
            transactionState: "uncommitted",
        });
        return block;
    } catch (error) {
        if (hasRetry) {
            if (error instanceof AllowanceHeld) retryAllowanceLogger.debug("recovery.delivery_retry.allowance_held", { ...retryFields, reason: error.reason });
            else retryAllowanceLogger.error("recovery.delivery_retry.allowance_failed", { ...retryFields, sourceError: initialOutreachDiagnostic(error) });
        }
        throw error;
    }
}
export async function currentAllowance(tx: Tx, conversationId: string, limits: AllowanceLimits) {
    const context = await requireAllowanceOwner(tx, conversationId);
    return currentAllowanceUnderOwnerLock(tx, context, limits);
}

async function currentAllowanceUnderOwnerLock(tx: Tx, context: RecoveryContext, limits: AllowanceLimits) {
    const conversationId = context.id;
    await adoptInitialUnderOwnerLock(tx, context, limits);
    const open = await tx.conversationAllowanceBlock.findFirst({ where: { conversationId, state: { in: ["PENDING", "ACTIVE"] } }, orderBy: { ordinal: "desc" } });
    if (open)
        return open;
    const cancelled = await tx.conversationAllowanceBlock.findFirst({ where: { conversationId, state: "CANCELLED" }, orderBy: { ordinal: "desc" } });
    if (!cancelled)
        throw new AllowanceHeld("funded-current-block-unavailable");
    return cancelled;
}
export async function allowanceUsage(tx: Tx, block: ConversationAllowanceBlock): Promise<number> {
    const value = await tx.usageEvent.aggregate({ where: { shopId: block.shopId, metric: "OUTBOUND_AUTOMATED_MESSAGE", sourceType: { in: ["OUTBOUND_AUTOMATED_MESSAGE", "OUTBOUND_AUTOMATED_TERMINAL"] }, sourceId: { in: (await tx.conversationMessage.findMany({ where: { conversationId: block.conversationId, direction: "OUTBOUND", ...(block.ordinal === 0 ? { OR: [{ allowanceBlockId: block.id }, { allowanceBlockId: null, senderType: { in: ["AGENT", "AUTOMATION"] } }] } : { allowanceBlockId: block.id }) }, select: { id: true } })).map(m => m.id) } }, _sum: { quantity: true } });
    return Number(value._sum.quantity ?? 0);
}
export async function notifyAllowanceBoundary(tx: Tx, block: ConversationAllowanceBlock, now: Date) {
    const thread = await tx.merchantSupportThread.upsert({ where: { shopId: block.shopId }, create: { shopId: block.shopId }, update: {} });
    await tx.merchantSupportMessage.upsert({ where: { sourceKey: `recovery-allowance:${block.conversationId}:${block.ordinal}:exhausted` }, create: { threadId: thread.id, kind: "SYSTEM", state: "AVAILABLE", originalBody: "This checkout conversation has used its current automated message allowance. If the allowance remains full, the next eligible customer continuation will use one new recovery credit and continue this same conversation. No credit is charged merely for reaching this limit.", sourceLanguageTag: "en-GB", systemCode: "RECOVERY_CONVERSATION_ALLOWANCE_EXHAUSTED", systemVersion: "1", sourceKey: `recovery-allowance:${block.conversationId}:${block.ordinal}:exhausted`, availableAt: now }, update: {} });
}
export async function hasCurrentContinuation(tx: Tx, conversationId: string, version: number) {
    const state = await tx.conversation.findUnique({ where: { id: conversationId }, select: { inboundVersion: true, pendingTurnStartedAt: true, lastProcessedVersion: true } });
    return !!state && state.inboundVersion === version && state.pendingTurnStartedAt !== null && state.lastProcessedVersion < version;
}
/** Must be called under the owner lock before reservation I/O. */
export async function createSuccessor(tx: Tx, input: {
    conversationId: string;
    limits: AllowanceLimits;
    kind: "CONTINUATION" | "FOLLOW_UP";
    now: Date;
    expectedControlRevision?: number;
    expectedInboundVersion?: number;
}) {
    const context = await lockRecoveryContext(tx, input.conversationId);
    if (!context || terminalRecovery(context.recoveryStatus))
        throw new AllowanceHeld("owner-closed");
    const evidence = await readRecoveryWindowEvidence(tx, { recoveryId: context.recoveryId, conversationId: context.id, now: input.now });
    if (!evidence || await hasLocalNoContact(tx, { shopId: context.shopId, recipient: evidence.recipient }))
        throw new AllowanceHeld("contact-blocked");
    if (input.kind === "CONTINUATION" && (!await hasCurrentContinuation(tx, context.id, input.expectedInboundVersion ?? -1) || context.mode !== "AI" || context.revision !== input.expectedControlRevision || context.inboundVersion !== input.expectedInboundVersion || !customerWindow(evidence.verifiedInboundAt, input.now).open))
        throw new AllowanceHeld("continuation-not-current");
    const current = await currentAllowanceUnderOwnerLock(tx, context, input.limits);
    if (current.state === "PENDING") {
        if (isFollowUpRetryBlock(current.id) || current.fundingKind !== input.kind)
            throw new AllowanceHeld("another-funding-intent");
        return { block: current, context };
    }
    let predecessor = current;
    if (current.state === "CANCELLED") {
        const lineage = await readBlockSource(tx, current);
        const source = lineage?.reservation;
        const opening = await tx.conversationMessage.findFirst({ where: { allowanceBlockId: current.id, direction: "OUTBOUND" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
        const other = opening ? await tx.conversationMessage.count({ where: { allowanceBlockId: current.id, id: { not: opening.id }, OR: [{ providerDispatchKey: { not: null } }, { providerDispatchAdmittedAt: { not: null } }, { providerMessageId: { not: null } }, { sentAt: { not: null } }] } }) : 0;
        if (!current.predecessorId || !opening || opening.status !== "FAILED" || other || !source || source.shopId !== context.shopId || !(source.status === "RELEASED" || source.status === "COMMITTED" && source.compensationUsageEventId))
            throw new AllowanceHeld("cancelled-retry-lineage-unproven");
        if (source.status === "COMMITTED")
            await readCommittedCorrectionReplay(tx, lineage!);
        else if (source.committedUsageEventId || source.compensationUsageEventId)
            throw new AllowanceHeld("cancelled-release-lineage-unproven");
        predecessor = await tx.conversationAllowanceBlock.findUniqueOrThrow({ where: { id: current.predecessorId } });
    }
    if (input.kind === "CONTINUATION" && (predecessor.state === "ACTIVE" ? await allowanceUsage(tx, predecessor) < predecessor.hardMessageLimit - predecessor.terminalReservedSlots : current.state !== "CANCELLED" || !["EXHAUSTED", "CLOSED"].includes(predecessor.state)))
        throw new AllowanceHeld("predecessor-capacity-available");
    const last = await tx.conversationAllowanceBlock.aggregate({ where: { conversationId: context.id }, _max: { ordinal: true } });
    // The same Meta window bounds continuation repair. No lease expiry permits resend.
    const deadline = input.kind === "CONTINUATION" ? customerWindow(evidence.verifiedInboundAt, input.now).closesAt! : new Date(input.now.getTime() + CUSTOMER_WINDOW_MS);
    const block = await tx.conversationAllowanceBlock.create({ data: { id: randomUUID(), shopId: context.shopId, conversationId: context.id, ordinal: (last._max.ordinal ?? -1) + 1, fundingKind: input.kind, state: "PENDING", predecessorId: predecessor.id, hardMessageLimit: input.limits.outboundHardLimit, terminalReservedSlots: input.limits.terminalMessageReservedSlots, repairDeadlineAt: deadline, repairAt: input.now } });
    return { block, context };
}
export async function readBlockSource(tx: Tx, block: ConversationAllowanceBlock) {
    if (!block.creditReservationId)
        return null;
    const source = await tx.usageReservation.findUnique({ where: { id: block.creditReservationId } });
    if (!source || source.shopId !== block.shopId)
        return null;
    const conversation = await tx.conversation.findUnique({ where: { id: block.conversationId }, select: { checkoutRecoveryId: true } });
    if (!conversation?.checkoutRecoveryId)
        return null;
    // Resolve the block's immutable reservation, never the newest attempt.
    // The canonical key can be bounded/hashed, so compare generated keys
    // rather than parsing the attempt ID from the persisted key.
    let logical: string;
    if (isFollowUpRetryBlock(block.id)) {
        const attemptId = followUpRetryAttemptId(block.id);
        if (!attemptId || block.fundingKind !== "FOLLOW_UP") return null;
        const attempt = await tx.recoveryOutreachAttempt.findUnique({ where: { id: attemptId },
            select: { checkoutRecoveryId: true, sequence: true, trigger: true, initiatedBy: true } });
        if (!attempt || attempt.checkoutRecoveryId !== conversation.checkoutRecoveryId || attempt.sequence < 3 ||
            attempt.trigger !== "NO_RESPONSE_FOLLOW_UP" || attempt.initiatedBy !== "AUTOMATION") return null;
        await readRetryFundingLineage(tx, { recoveryId: conversation.checkoutRecoveryId, conversationId: block.conversationId, attemptId });
        logical = createRecoveryIdempotencyKey(block.shopId, `recovery-outreach:${attemptId}`);
    } else if (block.fundingKind === "CONTINUATION") {
        logical = allowanceSourceKey(block.shopId, block.id);
    } else {
        const sequence = block.fundingKind === "INITIAL" ? 1 : 2;
        const original = await tx.recoveryOutreachAttempt.findUnique({ where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: conversation.checkoutRecoveryId, sequence } } });
        const keyFor = (id: string) => createRecoveryIdempotencyKey(block.shopId, `recovery-outreach:${id}`);
        const matches = (key: string) => source.sourceKey === key || (source.sourceKey.startsWith("paid-included:") && source.sourceKey.endsWith(`:${key}`));
        if (original && matches(keyFor(original.id))) {
            logical = keyFor(original.id);
        } else {
            const candidates = await tx.recoveryOutreachAttempt.findMany({ where: { checkoutRecoveryId: conversation.checkoutRecoveryId, sequence: { gte: 3 }, trigger: block.fundingKind === "INITIAL" ? "INITIAL" : { in: ["NO_RESPONSE_FOLLOW_UP", "POST_WINDOW_FOLLOW_UP"] } }, select: { id: true } });
            const matching = candidates.filter(attempt => matches(keyFor(attempt.id)));
            if (matching.length !== 1)
                return null;
            const attempt = matching[0]!;
            await readRetryFundingLineage(tx, { recoveryId: conversation.checkoutRecoveryId, conversationId: block.conversationId, attemptId: attempt.id });
            logical = keyFor(attempt.id);
        }
    }
    const found = await findExactReservationSource(tx, block.shopId, logical);
    if (!found || found.reservation.id !== block.creditReservationId)
        return null;
    return found;
}
export async function exactBlockSource(tx: Tx, block: ConversationAllowanceBlock) {
    const source = await readBlockSource(tx, block);
    return source?.reservation.compensationUsageEventId ? null : source;
}
/** Last reversible funding decision, while the caller holds the owner lock. */
export async function cancelReopenedContinuation(tx: Tx, blockId: string, messageId: string): Promise<boolean> {
    const pointer = await tx.conversationAllowanceBlock.findUniqueOrThrow({ where: { id: blockId } });
    const owner = await lockRecoveryContext(tx, pointer.conversationId);
    if (!owner || owner.shopId !== pointer.shopId)
        throw new AllowanceHeld("reopened-owner-unavailable");
    const block = await tx.conversationAllowanceBlock.findUniqueOrThrow({ where: { id: blockId } });
    if (block.state !== "PENDING" || block.fundingKind !== "CONTINUATION")
        return false;
    const opening = await tx.conversationMessage.findFirst({ where: { allowanceBlockId: block.id, direction: "OUTBOUND" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, conversationId: true } });
    if (!opening || opening.id !== messageId || opening.conversationId !== block.conversationId || await tx.conversationMessage.count({ where: { allowanceBlockId: block.id, direction: "OUTBOUND" } }) !== 1)
        throw new AllowanceHeld("reopened-opening-identity");
    const admitted = await tx.conversationMessage.count({ where: { allowanceBlockId: block.id, OR: [{ providerDispatchKey: { not: null } }, { providerDispatchAdmittedAt: { not: null } }, { providerMessageId: { not: null } }, { sentAt: { not: null } }] } });
    if (admitted)
        return false; // Provider permit freezes the action, even if its outcome is unknown.
    const predecessor = await tx.conversationAllowanceBlock.findUniqueOrThrow({ where: { id: block.predecessorId! } });
    if (predecessor.state !== "ACTIVE")
        return false; // Exact cancelled-lineage retry after an already frozen prior cycle.
    if (await allowanceUsage(tx, predecessor) >= predecessor.hardMessageLimit - predecessor.terminalReservedSlots)
        return false;
    const source = await exactBlockSource(tx, block);
    if (!source || source.reservation.status !== "RESERVED")
        throw new AllowanceHeld("reopened-funding-lineage");
    await releaseReservedSource(tx, source);
    const usage = await readExactAutomatedUsage(tx, block.shopId, messageId);
    await removeExactAutomatedUsage(tx, block.shopId, messageId, usage);
    await tx.conversationMessage.updateMany({ where: { id: messageId, allowanceBlockId: block.id, status: "PENDING", providerDispatchKey: null, providerDispatchAdmittedAt: null, providerMessageId: null, sentAt: null }, data: { status: "FAILED" } });
    await tx.conversationAllowanceBlock.update({ where: { id: block.id }, data: { state: "CANCELLED", repairAt: null, repairLeaseToken: null, repairLeaseUntil: null } });
    return true;
}
