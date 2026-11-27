import {
  hasConfirmedOutreachDelivery, nextRetryOutreachSequence, retryOutreachAttemptId, selectEffectiveOutreachAttempt,
  type OutreachSlot,
} from "./recovery-outreach-identity.js";
import { retryFundingLineage, type FundingAttempt, type RetryFundingLink } from "./recovery-retry-funding-lineage.js";

type ClaimIdentity = { attemptId: string; sequence: number; recipient: string; links: readonly RetryFundingLink[] };
export type RetryClaimPlan =
  | ({ kind: "new" | "existing" } & ClaimIdentity)
  | { kind: "held"; reason: "follow-up-present" | "lineage" | "not-current" | "predecessor-not-failed" | "already-progressed" | "initial-delivery-unproven" | "not-scheduled-follow-up" };

/** Pure claim planning. An intent is not a send permit. Use only after loading
 * every attempt for the exact recovery under the owner transaction. Reserve
 * original slots 1/2; a crash replays the same deterministic ID, not MAX+1. */
type ClaimInput = {
  intentId: string; recoveryId: string; conversationId: string; attempts: readonly FundingAttempt[];
};

export function planInitialRetryClaim(input: ClaimInput): RetryClaimPlan {
  return planRetryClaim(input, "INITIAL");
}

/** A follow-up retry is a physical replacement in the existing logical slot,
 * not a second scheduled or merchant follow-up. No database writes here. */
export type ScheduledFollowUpRetryPlan =
  | Extract<RetryClaimPlan, { kind: "held" }>
  | (ClaimIdentity & { kind: "new" | "existing"; initialAttemptId: string });

export function planScheduledFollowUpRetryClaim(input: ClaimInput): ScheduledFollowUpRetryPlan {
  const initial = selectEffectiveOutreachAttempt({ ...input, slot: "INITIAL" });
  if (initial.kind !== "selected") return { kind: "held", reason: "initial-delivery-unproven" };
  const attempt = initial.current;
  const message = attempt.outboundMessage;
  // The existing scheduled processor closes the initial as NO_RESPONSE.
  // Original sequence one retains its established SENT acceptance rule;
  // an initial physical retry must have positive delivery evidence.
  if (attempt.status !== "NO_RESPONSE" || attempt.customerRespondedAt || !attempt.sentAt || !message ||
      attempt.outboundMessageId !== message.id || message.conversationId !== input.conversationId ||
      message.direction !== "OUTBOUND" || message.senderType !== "AUTOMATION" || !message.providerMessageId ||
      message.sentAt?.getTime() !== attempt.sentAt.getTime() || message.failedAt ||
      !["SENT", "DELIVERED", "READ"].includes(message.status) ||
      (initial.retryCount > 0 && !hasConfirmedOutreachDelivery(attempt, input.conversationId))) {
    return { kind: "held", reason: "initial-delivery-unproven" };
  }
  const followUp = selectEffectiveOutreachAttempt({ ...input, slot: "FOLLOW_UP" });
  if (followUp.kind !== "selected") return { kind: "held", reason: "lineage" };
  if (followUp.chain.some(row => row.trigger !== "NO_RESPONSE_FOLLOW_UP" || row.initiatedBy !== "AUTOMATION" ||
      row.recipient.replace(/^\+/, "") !== attempt.recipient.replace(/^\+/, ""))) {
    return { kind: "held", reason: "not-scheduled-follow-up" };
  }
  const plan = planRetryClaim(input, "FOLLOW_UP");
  if (plan.kind === "held") return plan;
  if (plan.links.some(({ predecessor }) => !predecessor.sentAt ||
      predecessor.outboundMessage?.sentAt?.getTime() !== predecessor.sentAt.getTime())) {
    return { kind: "held", reason: "predecessor-not-failed" };
  }
  return { ...plan, initialAttemptId: attempt.id };
}

function planRetryClaim(input: ClaimInput, slot: OutreachSlot): RetryClaimPlan {
  const { attempts, intentId, recoveryId, conversationId } = input;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(intentId)) return { kind: "held", reason: "lineage" };
  const selection = selectEffectiveOutreachAttempt({ recoveryId, conversationId, slot, attempts });
  if (selection.kind !== "selected") return { kind: "held", reason: "lineage" };
  // A successful initial followed by a logical follow-up is not an initial
  // retry candidate, even if a later failure webhook arrives for the initial.
  if (slot === "INITIAL" && attempts.some(attempt => attempt.sequence === 2 || attempt.trigger !== "INITIAL")) {
    return { kind: "held", reason: "follow-up-present" };
  }
  const attemptId = retryOutreachAttemptId(intentId);
  const existing = attempts.find(attempt => attempt.id === attemptId);
  if (existing && selection.current.id !== existing.id) return { kind: "held", reason: "not-current" };
  const predecessor = existing ? selection.chain.at(-2) : selection.current;
  if (!predecessor || predecessor.deliveryRetryIntent?.id !== intentId) return { kind: "held", reason: "not-current" };
  const intent = predecessor.deliveryRetryIntent;
  const message = predecessor.outboundMessage;
  if (intent.cancelledAt || predecessor.status !== "FAILED" || predecessor.initiatedBy === "HUMAN" ||
      predecessor.customerRespondedAt || !message || predecessor.outboundMessageId !== message.id ||
      message.status !== "FAILED" || !message.failedAt || !message.sentAt || !message.providerMessageId ||
      message.deliveredAt || message.readAt || message.conversationId !== conversationId ||
      message.direction !== "OUTBOUND" || message.senderType !== "AUTOMATION") {
    return { kind: "held", reason: "predecessor-not-failed" };
  }
  if (existing && (!['PENDING', 'CAPACITY_BLOCKED'].includes(existing.status) || existing.outboundMessageId ||
      existing.sentAt || existing.customerRespondedAt || existing.deliveryRetryIntent)) {
    return { kind: "held", reason: "already-progressed" };
  }
  let sequence: number;
  try { sequence = existing?.sequence ?? nextRetryOutreachSequence(attempts); }
  catch { return { kind: "held", reason: "lineage" }; }
  const proposed: FundingAttempt = existing ?? {
    id: attemptId, checkoutRecoveryId: recoveryId, sequence, trigger: predecessor.trigger, recipient: predecessor.recipient,
    initiatedBy: slot === "INITIAL" ? null : "AUTOMATION", status: "PENDING", sentAt: null, customerRespondedAt: null,
    outboundMessageId: null, outboundMessage: null, deliveryRetryIntent: null,
  };
  const candidateAttempts = existing ? attempts : [...attempts, proposed];
  const candidateSelection = selectEffectiveOutreachAttempt({ recoveryId, conversationId, slot, attempts: candidateAttempts });
  const links = retryFundingLineage({ recoveryId, conversationId, attemptId, attempts: candidateAttempts });
  if (candidateSelection.kind !== "selected" || candidateSelection.current.id !== attemptId || !links?.length) {
    return { kind: "held", reason: "lineage" };
  }
  return { kind: existing ? "existing" : "new", attemptId, sequence, recipient: predecessor.recipient, links };
}
