import { isInitialRetryId } from "./recovery-outreach-identity.js";
import type { RetryFundingLink } from "./recovery-retry-funding-lineage.js";

/** A projection of persisted ownership, not a mutable allowance or permission.
 * Outbound IDs are read from each block (up to two, enough to detect a second
 * message). Historical reservations may never be reassigned to a new block. */
export type FollowUpRetryAllowanceEvidence = {
  id: string;
  shopId: string;
  conversationId: string;
  ordinal: number;
  fundingKind: string;
  state: string;
  predecessorId: string | null;
  creditReservationId: string | null;
  repairAt: Date | null;
  repairLeaseToken: string | null;
  repairLeaseUntil: Date | null;
  outboundMessageIds: readonly string[];
};

export type FollowUpRetryAllowanceLineage =
  | { kind: "proven"; initialBlockId: string; failedBlockId: string }
  | {
      kind: "held";
      reason:
        | "allowance-owner"
        | "initial-allowance"
        | "failed-allowance"
        | "other-allowance";
    };

/** This pre-creation gate deliberately holds if there is already another block
 * (including a pending successor). The funding/restart owner must reconcile
 * such a block separately, never infer its source from sequence two. */
export function proveFollowUpRetryAllowance(input: {
  shopId: string;
  conversationId: string;
  initialReservationId: string;
  links: readonly RetryFundingLink[];
  blocks: readonly FollowUpRetryAllowanceEvidence[];
}): FollowUpRetryAllowanceLineage {
  const { blocks, links } = input;
  if (
    blocks.some(
      (b) =>
        b.shopId !== input.shopId || b.conversationId !== input.conversationId,
    ) ||
    new Set(blocks.map((b) => b.id)).size !== blocks.length ||
    new Set(blocks.map((b) => b.ordinal)).size !== blocks.length
  )
    return { kind: "held", reason: "allowance-owner" };
  const initial = blocks.find((b) => b.fundingKind === "INITIAL");
  if (
    !initial ||
    !input.initialReservationId ||
    initial.creditReservationId !== input.initialReservationId ||
    initial.ordinal !== 0 ||
    initial.predecessorId !== null ||
    !["ACTIVE", "EXHAUSTED", "CLOSED"].includes(initial.state)
  ) {
    return { kind: "held", reason: "initial-allowance" };
  }
  if (!links.length || blocks.length !== links.length + 1)
    return { kind: "held", reason: "other-allowance" };
  const used = new Set([initial.id]);
  let ordinal = initial.ordinal;
  let failedBlockId = "";
  for (const { predecessor, intent } of links) {
    const matches = blocks.filter(
      (b) => b.creditReservationId === intent.fundingReservationId,
    );
    const block = matches[0];
    // Match the failed opener, not merely a cancelled block with the same
    // ordinal. Refuse any additional outbound message rather than recycling a
    // block whose consumption history has not been fully reconciled.
    if (
      !block ||
      matches.length !== 1 ||
      used.has(block.id) ||
      block.fundingKind !== "FOLLOW_UP" ||
      block.state !== "CANCELLED" ||
      block.predecessorId !== initial.id ||
      block.ordinal <= ordinal ||
      block.repairAt ||
      block.repairLeaseToken ||
      block.repairLeaseUntil ||
      intent.failedAttemptId !== predecessor.id ||
      predecessor.outboundMessageId !== intent.failedMessageId ||
      block.outboundMessageIds.length !== 1 ||
      block.outboundMessageIds[0] !== intent.failedMessageId
    ) {
      return { kind: "held", reason: "failed-allowance" };
    }
    used.add(block.id);
    ordinal = block.ordinal;
    failedBlockId = block.id;
  }
  return { kind: "proven", initialBlockId: initial.id, failedBlockId };
}

/** The attempt and reservation own this block permanently. Never reuse the
 * sequence-two block or rebind a cancelled allowance. */
export const followUpRetryBlockId = (attemptId: string) =>
  `allowance_${attemptId}`;

/** Reserve this namespace for the dedicated follow-up retry owner. Legacy
 * allowance IDs are generated independently (UUIDs). Malformed reserved IDs
 * are held too, never treated as a legacy sequence-two allowance. */
export const FOLLOW_UP_RETRY_BLOCK_PREFIX = "allowance_retry_";
export const isFollowUpRetryBlock = (blockId: string): boolean =>
  blockId.startsWith(FOLLOW_UP_RETRY_BLOCK_PREFIX);
export function followUpRetryAttemptId(blockId: string): string | null {
  const attemptId = blockId.slice("allowance_".length);
  return isFollowUpRetryBlock(blockId) && isInitialRetryId(attemptId)
    ? attemptId
    : null;
}

/** The funding owner expects an empty block; only final admission may prove
 * a prepared opener. No generic message can become the funded opener. */
export function exactFollowUpRetryOpening(
  ids: readonly string[],
  preparedMessageId?: string,
): boolean {
  return preparedMessageId === undefined
    ? ids.length === 0
    : !!preparedMessageId && ids.length === 1 && ids[0] === preparedMessageId;
}

type PendingAllowanceEvidence = FollowUpRetryAllowanceEvidence & {
  repairDeadlineAt: Date | null;
};
type ProvenAllowance = Extract<
  FollowUpRetryAllowanceLineage,
  { kind: "proven" }
>;

/** A replay may have exactly one new, still-empty funded block. Its credit
 * is supplied by the exact reservation reader under the same owner locks.
 * Progressed, expired, leased or unrelated blocks are held for reconciliation. */
export function proveFundedFollowUpRetryAllowance(input: {
  shopId: string;
  conversationId: string;
  initialReservationId: string;
  links: readonly RetryFundingLink[];
  blocks: readonly PendingAllowanceEvidence[];
  attemptId: string;
  reservationId: string;
  now: Date;
  preparedMessageId?: string;
}):
  | (ProvenAllowance & { blockId: string })
  | {
      kind: "held";
      reason:
        | "funded-allowance"
        | Extract<FollowUpRetryAllowanceLineage, { kind: "held" }>["reason"];
    } {
  const blockId = followUpRetryBlockId(input.attemptId);
  const matching = input.blocks.filter((b) => b.id === blockId);
  const block = matching[0];
  const historical = input.blocks.filter((b) => b.id !== blockId);
  if (
    !block ||
    matching.length !== 1 ||
    block.shopId !== input.shopId ||
    block.conversationId !== input.conversationId ||
    block.fundingKind !== "FOLLOW_UP" ||
    block.state !== "PENDING" ||
    !input.reservationId ||
    block.creditReservationId !== input.reservationId ||
    historical.some((b) => b.creditReservationId === input.reservationId) ||
    !exactFollowUpRetryOpening(
      block.outboundMessageIds,
      input.preparedMessageId,
    ) ||
    block.repairLeaseToken ||
    block.repairLeaseUntil ||
    !block.repairAt ||
    !block.repairDeadlineAt ||
    block.repairDeadlineAt <= input.now ||
    block.repairAt > block.repairDeadlineAt ||
    !Number.isFinite(input.now.getTime()) ||
    !Number.isSafeInteger(block.ordinal) ||
    historical.some((b) => b.ordinal >= block.ordinal)
  ) {
    return { kind: "held", reason: "funded-allowance" };
  }
  const proof = proveFollowUpRetryAllowance({ ...input, blocks: historical });
  if (proof.kind === "held") return proof;
  if (block.predecessorId !== proof.initialBlockId)
    return { kind: "held", reason: "funded-allowance" };
  return { ...proof, blockId };
}
