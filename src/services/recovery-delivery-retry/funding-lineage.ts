import {
  retryFundingLineage,
  type RetryFundingLink,
} from "../../domain/recovery-retry-funding-lineage.js";
import { selectEffectiveOutreachAttempt } from "../../domain/recovery-outreach-identity.js";
import {
  requireLineage,
  type CompensationTransaction,
} from "../recovery-delivery-compensation/types.js";
import { recoveryOutreachIdentitySelect } from "./outreach-selection.js";

export const retryFundingIdentitySelect = {
  ...recoveryOutreachIdentitySelect,
  deliveryRetryIntent: {
    select: {
      ...recoveryOutreachIdentitySelect.deliveryRetryIntent.select,
      fundingReservationId: true,
    },
  },
} as const;

type RetryIdentity = {
  recoveryId: string;
  conversationId: string;
  attemptId: string;
};

/** Only used for physical retries, preserving original attempt behaviour. */
export async function readRetryFundingLineage(
  tx: CompensationTransaction,
  input: RetryIdentity,
): Promise<readonly RetryFundingLink[]> {
  const attempts = await tx.recoveryOutreachAttempt.findMany({
    where: { checkoutRecoveryId: input.recoveryId },
    select: retryFundingIdentitySelect,
  });
  const links = retryFundingLineage({ ...input, attempts });
  requireLineage(links, "physical retry predecessor identity mismatch");
  return links;
}

/** Read-only current-attempt gate for an initial retry. The caller owns the
 * Shop -> Conversation lock and must still enforce retry policy, consent,
 * budget, checkout generation and provider admission before any send.
 */
export async function requireCurrentInitialRetry(
  tx: CompensationTransaction,
  input: RetryIdentity,
): Promise<readonly RetryFundingLink[]> {
  const attempts = await tx.recoveryOutreachAttempt.findMany({
    where: { checkoutRecoveryId: input.recoveryId },
    select: retryFundingIdentitySelect,
  });
  const selection = selectEffectiveOutreachAttempt({
    ...input,
    slot: "INITIAL",
    attempts,
  });
  requireLineage(
    selection.kind === "selected" &&
      selection.current.id === input.attemptId &&
      selection.retryCount > 0,
    "initial retry is not current",
  );
  const links = retryFundingLineage({ ...input, attempts });
  requireLineage(links, "initial retry predecessor identity mismatch");
  requireLineage(
    (await tx.conversationAllowanceBlock.count({
      where: { conversationId: input.conversationId },
    })) === 0,
    "initial retry has an existing allowance block",
  );
  return links;
}
