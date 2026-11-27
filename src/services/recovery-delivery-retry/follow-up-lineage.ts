import type { Prisma } from "@prisma/client";
import { planScheduledFollowUpRetryClaim } from "../../domain/recovery-retry-claim.js";
import { proveFollowUpRetryAllowance, proveFundedFollowUpRetryAllowance } from "../../domain/recovery-follow-up-retry-allowance.js";
import { findExactRecoveryReservationSource } from "../recovery-delivery-compensation/lineage.js";
import { readCommittedRecoveryUsage } from "../recovery-delivery-compensation/committed-usage.js";
import { requireLineage } from "../recovery-delivery-compensation/types.js";
import { retryFundingIdentitySelect } from "./funding-lineage.js";
import { requireInitialRetryPredecessorReady } from "./funding.js";

/** Read-only foundation for a future scheduled follow-up claim/funding owner.
 * Caller MUST hold the Shop -> Conversation locks in its current transaction.
 * This is neither full eligibility nor permission to create, fund or dispatch.
 * Current platform consent, checkout authority, billing, sender and the final
 * permit remain additional mandatory gates. The funding owner may supply its
 * exact revalidated reservation for a clean replay; the default pre-creation
 * proof still refuses any additional allowance block. */
export async function inspectScheduledFollowUpRetryLineage(tx: Prisma.TransactionClient, input: {
  shopId: string; recoveryId: string; conversationId: string; intentId: string; now: Date;
  fundedReservationId?: string;
  /** Only the explicit final permit may supply the exact prepared opener. */
  preparedMessageId?: string;
}) {
  if (input.preparedMessageId !== undefined && !input.fundedReservationId) return { kind: "held" as const, reason: "funded-claim-missing" };
  const attempts = await tx.recoveryOutreachAttempt.findMany({
    where: { checkoutRecoveryId: input.recoveryId }, select: retryFundingIdentitySelect,
  });
  const plan = planScheduledFollowUpRetryClaim({ ...input, attempts });
  if (plan.kind === "held") return plan;
  // Despite its historical name, this predecessor gate does not assume an
  // allowance-free conversation. Reuse its generation, cooldown, budget,
  // local STOP, inbound history and exact compensation checks unchanged.
  await requireInitialRetryPredecessorReady(tx, input, plan.links);
  const initialSource = await findExactRecoveryReservationSource(tx, input.shopId, plan.initialAttemptId);
  requireLineage(initialSource?.reservation.status === "COMMITTED" && !initialSource.reservation.compensationUsageEventId &&
    !initialSource.reservation.compensationReason && !initialSource.reservation.compensationDisposition && !initialSource.reservation.compensatedAt,
  "follow-up retry initial funding is not an uncorrected commitment");
  await readCommittedRecoveryUsage(tx, initialSource);
  const blocks = await tx.conversationAllowanceBlock.findMany({ where: { conversationId: input.conversationId }, select: {
    id: true, shopId: true, conversationId: true, ordinal: true, fundingKind: true, state: true,
    predecessorId: true, creditReservationId: true, repairAt: true, repairLeaseToken: true, repairLeaseUntil: true, repairDeadlineAt: true,
    messages: { where: { direction: "OUTBOUND" }, select: { id: true }, take: 2 },
  } });
  const evidence = { ...input, initialReservationId: initialSource.reservation.id,
    links: plan.links, blocks: blocks.map(({ messages, ...block }) => ({ ...block, outboundMessageIds: messages.map(m => m.id) })) };
  if (input.fundedReservationId !== undefined) {
    if (plan.kind !== "existing") return { kind: "held" as const, reason: "funded-claim-missing" };
    const allowance = proveFundedFollowUpRetryAllowance({ ...evidence, attemptId: plan.attemptId, reservationId: input.fundedReservationId });
    return allowance.kind === "held" ? allowance : { kind: "proven" as const, plan, allowance, fundedBlockId: allowance.blockId };
  }
  const allowance = proveFollowUpRetryAllowance(evidence);
  return allowance.kind === "held" ? allowance : { kind: "proven" as const, plan, allowance, fundedBlockId: null };
}
