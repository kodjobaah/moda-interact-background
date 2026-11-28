import {
  outreachSlot,
  retryOutreachAttemptId,
  type OutreachAttemptIdentity,
} from "./recovery-outreach-identity.js";

export type FundingAttempt = Omit<
  OutreachAttemptIdentity,
  "deliveryRetryIntent"
> & {
  deliveryRetryIntent:
    | (NonNullable<OutreachAttemptIdentity["deliveryRetryIntent"]> & {
        fundingReservationId: string;
      })
    | null;
};

export type RetryFundingLink = {
  predecessor: FundingAttempt;
  intent: NonNullable<FundingAttempt["deliveryRetryIntent"]>;
};

/** Historical identity is deliberately independent of current eligibility.
 * A cancelled intent or late positive receipt must not prevent settlement or
 * compensation of a distinct, already-admitted physical send. New funding
 * requires the stricter effective-outreach selector and current policy gates.
 */
export function retryFundingLineage(input: {
  recoveryId: string;
  conversationId: string;
  attemptId: string;
  attempts: readonly FundingAttempt[];
}): readonly RetryFundingLink[] | null {
  const attempts = new Map(input.attempts.map((a) => [a.id, a]));
  if (attempts.size !== input.attempts.length) return null;
  const seenSequences = new Set<number>();
  const intents = new Map<string, RetryFundingLink>();
  for (const attempt of input.attempts) {
    if (
      attempt.checkoutRecoveryId !== input.recoveryId ||
      !Number.isInteger(attempt.sequence) ||
      attempt.sequence < 1 ||
      attempt.sequence > 2_147_483_647 ||
      seenSequences.has(attempt.sequence)
    )
      return null;
    seenSequences.add(attempt.sequence);
    const intent = attempt.deliveryRetryIntent;
    if (!intent) continue;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(intent.id) || intents.has(intent.id))
      return null;
    intents.set(intent.id, { predecessor: attempt, intent });
  }
  let current = attempts.get(input.attemptId);
  if (!current || current.sequence < 3) return null;
  const slot = outreachSlot(current.trigger);
  if (!slot) return null;
  const links: RetryFundingLink[] = [];
  while (current.sequence >= 3) {
    if (
      !/^retry_[A-Za-z0-9_-]{1,100}$/.test(current.id) ||
      current.initiatedBy === "HUMAN"
    )
      return null;
    const link = intents.get(current.id.slice("retry_".length));
    if (!link) return null;
    const { predecessor, intent } = link;
    const message = predecessor.outboundMessage;
    if (
      current.id !== retryOutreachAttemptId(intent.id) ||
      predecessor.sequence >= current.sequence ||
      predecessor.trigger !== current.trigger ||
      predecessor.recipient !== current.recipient ||
      predecessor.initiatedBy === "HUMAN" ||
      intent.failedAttemptId !== predecessor.id ||
      !intent.fundingReservationId ||
      !message ||
      message.id !== predecessor.outboundMessageId ||
      intent.failedMessageId !== message.id ||
      message.conversationId !== input.conversationId ||
      message.direction !== "OUTBOUND" ||
      message.senderType !== "AUTOMATION" ||
      !message.providerMessageId ||
      !message.failedAt
    )
      return null;
    // The successor may not have a message yet. If it does, it must belong
    // to the same conversation and be an automated send.
    if (
      current.outboundMessageId !== null &&
      (!current.outboundMessage ||
        current.outboundMessage.id !== current.outboundMessageId ||
        current.outboundMessage.conversationId !== input.conversationId ||
        current.outboundMessage.direction !== "OUTBOUND" ||
        current.outboundMessage.senderType !== "AUTOMATION")
    )
      return null;
    links.unshift(link);
    current = predecessor;
  }
  return current.sequence === (slot === "INITIAL" ? 1 : 2) ? links : null;
}
