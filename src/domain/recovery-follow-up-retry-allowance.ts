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
  | { kind: "held"; reason: "allowance-owner" | "initial-allowance" | "failed-allowance" | "other-allowance" };

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
  if (blocks.some(b => b.shopId !== input.shopId || b.conversationId !== input.conversationId) ||
      new Set(blocks.map(b => b.id)).size !== blocks.length ||
      new Set(blocks.map(b => b.ordinal)).size !== blocks.length) return { kind: "held", reason: "allowance-owner" };
  const initial = blocks.find(b => b.fundingKind === "INITIAL");
  if (!initial || !input.initialReservationId || initial.creditReservationId !== input.initialReservationId ||
      initial.ordinal !== 0 || initial.predecessorId !== null || !["ACTIVE", "EXHAUSTED", "CLOSED"].includes(initial.state)) {
    return { kind: "held", reason: "initial-allowance" };
  }
  if (!links.length || blocks.length !== links.length + 1) return { kind: "held", reason: "other-allowance" };
  const used = new Set([initial.id]);
  let ordinal = initial.ordinal;
  let failedBlockId = "";
  for (const { predecessor, intent } of links) {
    const matches = blocks.filter(b => b.creditReservationId === intent.fundingReservationId);
    const block = matches[0];
    // Match the failed opener, not merely a cancelled block with the same
    // ordinal. Refuse any additional outbound message rather than recycling a
    // block whose consumption history has not been fully reconciled.
    if (!block || matches.length !== 1 || used.has(block.id) || block.fundingKind !== "FOLLOW_UP" ||
        block.state !== "CANCELLED" || block.predecessorId !== initial.id || block.ordinal <= ordinal ||
        block.repairAt || block.repairLeaseToken || block.repairLeaseUntil ||
        intent.failedAttemptId !== predecessor.id || predecessor.outboundMessageId !== intent.failedMessageId ||
        block.outboundMessageIds.length !== 1 || block.outboundMessageIds[0] !== intent.failedMessageId) {
      return { kind: "held", reason: "failed-allowance" };
    }
    used.add(block.id);
    ordinal = block.ordinal;
    failedBlockId = block.id;
  }
  return { kind: "proven", initialBlockId: initial.id, failedBlockId };
}
