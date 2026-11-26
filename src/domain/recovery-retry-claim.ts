import {
  nextRetryOutreachSequence, retryOutreachAttemptId, selectEffectiveOutreachAttempt,
} from "./recovery-outreach-identity.js";
import { retryFundingLineage, type FundingAttempt, type RetryFundingLink } from "./recovery-retry-funding-lineage.js";

type ClaimIdentity = { attemptId: string; sequence: number; recipient: string; links: readonly RetryFundingLink[] };
export type RetryClaimPlan =
  | ({ kind: "new" | "existing" } & ClaimIdentity)
  | { kind: "held"; reason: "follow-up-present" | "lineage" | "not-current" | "predecessor-not-failed" | "already-progressed" };

/** Pure claim planning. An intent is not a send permit. Use only after loading
 * every attempt for the exact recovery under the owner transaction. Reserve
 * original slots 1/2; a crash replays the same deterministic ID, not MAX+1. */
export function planInitialRetryClaim(input: {
  intentId: string; recoveryId: string; conversationId: string; attempts: readonly FundingAttempt[];
}): RetryClaimPlan {
  const { attempts, intentId, recoveryId, conversationId } = input;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(intentId)) return { kind: "held", reason: "lineage" };
  const selection = selectEffectiveOutreachAttempt({ recoveryId, conversationId, slot: "INITIAL", attempts });
  if (selection.kind !== "selected") return { kind: "held", reason: "lineage" };
  // A successful initial followed by a logical follow-up is not an initial
  // retry candidate, even if a later failure webhook arrives for the initial.
  if (attempts.some(attempt => attempt.sequence === 2 || attempt.trigger !== "INITIAL")) {
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
    id: attemptId, checkoutRecoveryId: recoveryId, sequence, trigger: "INITIAL", recipient: predecessor.recipient,
    initiatedBy: null, status: "PENDING", sentAt: null, customerRespondedAt: null,
    outboundMessageId: null, outboundMessage: null, deliveryRetryIntent: null,
  };
  const candidateAttempts = existing ? attempts : [...attempts, proposed];
  const candidateSelection = selectEffectiveOutreachAttempt({ recoveryId, conversationId, slot: "INITIAL", attempts: candidateAttempts });
  const links = retryFundingLineage({ recoveryId, conversationId, attemptId, attempts: candidateAttempts });
  if (candidateSelection.kind !== "selected" || candidateSelection.current.id !== attemptId || !links?.length) {
    return { kind: "held", reason: "lineage" };
  }
  return { kind: existing ? "existing" : "new", attemptId, sequence, recipient: predecessor.recipient, links };
}
