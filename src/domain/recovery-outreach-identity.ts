export type OutreachSlot = "INITIAL" | "FOLLOW_UP";
export type OriginalOutreachSequence = 1 | 2;
export type OutreachTrigger = "INITIAL" | "NO_RESPONSE_FOLLOW_UP" | "POST_WINDOW_FOLLOW_UP";

export function originalOutreachTrigger(sequence: OriginalOutreachSequence): Exclude<OutreachTrigger, "POST_WINDOW_FOLLOW_UP"> {
  if (sequence === 1) return "INITIAL";
  if (sequence === 2) return "NO_RESPONSE_FOLLOW_UP";
  throw new Error(`Invalid original outreach sequence: ${sequence}`);
}

export function outreachSlot(trigger: string): OutreachSlot | null {
  if (trigger === "INITIAL") return "INITIAL";
  if (trigger === "NO_RESPONSE_FOLLOW_UP" || trigger === "POST_WINDOW_FOLLOW_UP") return "FOLLOW_UP";
  return null;
}

export const isInitialRetryId = (id: string): boolean => /^retry_[A-Za-z0-9_-]{1,100}$/.test(id);

/** Shape gate only. The execution and provider fences must verify persisted lineage. */
export function isInitialOutreachIdentity(attempt: { id: string; sequence: number; trigger: string }): boolean {
  return attempt.trigger === "INITIAL" && Number.isSafeInteger(attempt.sequence) &&
    (isInitialRetryId(attempt.id) ? attempt.sequence >= 3 && attempt.sequence <= 2_147_483_647 : attempt.sequence === 1);
}

export function initialOutreachRecoveryStateAllowed(attemptId: string, status: string): boolean {
  return status === "DETECTED" || (isInitialRetryId(attemptId) && status === "MESSAGE_SENT");
}

/** The ID is derived from the durable intent, not a job or delivery receipt.
 * Creation and re-read must be serialized by the recovery/checkout lock.
 */
export function retryOutreachAttemptId(intentId: string): string {
  // Keep recovery-outreach:retry_<id> within the existing 128-character
  // provider dispatch key limit (and the compensation key parser).
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(intentId)) throw new Error("Invalid recovery retry intent identity");
  return `retry_${intentId}`;
}

/** Call only inside a serialized claim transaction. This is allocation, not
 * authorization; retry policy, budget, funding and provider permits are separate.
 */
export function nextRetryOutreachSequence(attempts: ReadonlyArray<{ sequence: number }>): number {
  let greatest = 2;
  const seen = new Set<number>();
  for (const { sequence } of attempts) {
    if (!Number.isInteger(sequence) || sequence < 1 || sequence > 2_147_483_647 || seen.has(sequence)) {
      throw new Error("Invalid or duplicate recovery outreach sequence");
    }
    seen.add(sequence);
    greatest = Math.max(greatest, sequence);
  }
  if (greatest === 2_147_483_647) throw new Error("Recovery outreach sequence exhausted");
  return greatest + 1;
}

export type OutreachMessageIdentity = {
  id: string;
  conversationId: string;
  direction: string;
  senderType: string;
  status: string;
  providerMessageId: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  failedAt: Date | null;
};

export type OutreachAttemptIdentity = {
  id: string;
  checkoutRecoveryId: string;
  sequence: number;
  trigger: string;
  recipient: string;
  initiatedBy: string | null;
  status: string;
  sentAt: Date | null;
  customerRespondedAt: Date | null;
  outboundMessageId: string | null;
  outboundMessage: OutreachMessageIdentity | null;
  deliveryRetryIntent: {
    id: string;
    failedAttemptId: string;
    failedMessageId: string;
    cancelledAt: Date | null;
  } | null;
};

type SelectionConflict = "attempt-identity" | "missing-original" | "orphan-retry" | "retry-lineage";
export type EffectiveOutreachSelection<T extends OutreachAttemptIdentity> =
  | { kind: "missing" }
  | { kind: "conflict"; reason: SelectionConflict }
  | { kind: "selected"; original: T; current: T; chain: readonly T[]; retryCount: number };

function ownsMessage(attempt: OutreachAttemptIdentity, conversationId: string | null): boolean {
  const message = attempt.outboundMessage;
  return !!conversationId && !!message && message.id === attempt.outboundMessageId &&
    message.conversationId === conversationId && message.direction === "OUTBOUND";
}

/** Positive delivery, not just provider HTTP acceptance. A retained FAILED
 * timestamp does not negate a subsequently authenticated DELIVERED/READ receipt.
 */
export function hasConfirmedOutreachDelivery(attempt: OutreachAttemptIdentity, conversationId: string | null): boolean {
  if (!ownsMessage(attempt, conversationId)) return false;
  const message = attempt.outboundMessage!;
  return !!attempt.sentAt && !!message.sentAt && !!message.providerMessageId &&
    (message.status === "DELIVERED" && !!message.deliveredAt ||
      message.status === "READ" && !!message.readAt);
}

/** Select the current physical attempt, not the highest sequence or latest
 * successful historical row. Every retry must be reached from its original
 * slot through the exact predecessor's durable intent. Conflicting or late
 * positive evidence holds automated decisions; it must not erase history.
 * This is a read-only selector, never permission to create, fund or send.
 */
export function selectEffectiveOutreachAttempt<T extends OutreachAttemptIdentity>(input: {
  recoveryId: string;
  conversationId: string | null;
  slot: OutreachSlot;
  attempts: readonly T[];
}): EffectiveOutreachSelection<T> {
  const byId = new Map<string, T>();
  const sequences = new Set<number>();
  const groups: Record<OutreachSlot, T[]> = { INITIAL: [], FOLLOW_UP: [] };
  for (const attempt of input.attempts) {
    const slot = outreachSlot(attempt.trigger);
    if (!attempt.id || attempt.checkoutRecoveryId !== input.recoveryId || !slot ||
        !Number.isInteger(attempt.sequence) || attempt.sequence < 1 || attempt.sequence > 2_147_483_647 ||
        byId.has(attempt.id) || sequences.has(attempt.sequence) ||
        (attempt.sequence === 1 && slot !== "INITIAL") || (attempt.sequence === 2 && slot !== "FOLLOW_UP") ||
        (attempt.sequence >= 3 && !/^retry_[A-Za-z0-9_-]{1,100}$/.test(attempt.id))) {
      return { kind: "conflict", reason: "attempt-identity" };
    }
    byId.set(attempt.id, attempt);
    sequences.add(attempt.sequence);
    groups[slot].push(attempt);
  }
  const group = groups[input.slot];
  if (!group.length) return { kind: "missing" };
  const original = group.find(attempt => attempt.sequence === (input.slot === "INITIAL" ? 1 : 2));
  if (!original) return { kind: "conflict", reason: "missing-original" };
  const chain: T[] = [original];
  let current = original;
  while (current.deliveryRetryIntent) {
    const intent = current.deliveryRetryIntent;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(intent.id) || intent.failedAttemptId !== current.id ||
        !current.outboundMessageId || intent.failedMessageId !== current.outboundMessageId) {
      return { kind: "conflict", reason: "retry-lineage" };
    }
    const successor = byId.get(retryOutreachAttemptId(intent.id));
    if (!successor) break; // Intent alone is not a physical attempt.
    const message = current.outboundMessage;
    if (intent.cancelledAt || current.status !== "FAILED" || current.customerRespondedAt ||
        current.initiatedBy === "HUMAN" || !ownsMessage(current, input.conversationId) ||
        !message || message.senderType !== "AUTOMATION" || message.status !== "FAILED" ||
        !message.failedAt || !message.providerMessageId || message.deliveredAt || message.readAt ||
        successor.trigger !== current.trigger || successor.recipient !== current.recipient ||
        successor.initiatedBy === "HUMAN" || successor.sequence < 3 || successor.sequence <= current.sequence ||
        (successor.outboundMessageId !== null && (!ownsMessage(successor, input.conversationId) ||
          successor.outboundMessage?.senderType !== "AUTOMATION"))) {
      return { kind: "conflict", reason: "retry-lineage" };
    }
    chain.push(successor);
    current = successor;
  }
  if (chain.length !== group.length) return { kind: "conflict", reason: "orphan-retry" };
  return { kind: "selected", original, current, chain, retryCount: chain.length - 1 };
}
