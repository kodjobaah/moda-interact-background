import { decideRecoveryOutreachRetry } from "../../domain/recovery-outreach-retry-policy.js";
import { requireLineage, type CompensationTransaction } from "../recovery-delivery-compensation/types.js";

type RetryIntentInput = {
  attemptId: string;
  expectedGeneration: number;
  expectedLastExternalActivityAt: Date;
  messageId: string;
  reservationId: string;
  providerFailureCode: string | null;
  failedAt: Date;
};

/** Called inside the existing compensation transaction, after source correction.
 * The message lock and exact source/attempt lineage are already established.
 * This records a candidate decision only. No queue, credit reservation or send.
 */
export async function recordRecoveryDeliveryRetryIntent(
  tx: CompensationTransaction,
  input: RetryIntentInput,
): Promise<void> {
  // Read the current authoritative singleton, not the runtime service's
  // last-good cache. Missing settings yield an inert REVIEW_REQUIRED intent.
  // Database errors remain transactional errors and follow existing retries.
  const config = await tx.backgroundRuntimeConfig.findUnique({
    where: { id: "default" },
    select: {
      recoveryDeliveryTemporaryRetryDelayMinutes: true,
      recoveryDeliveryRateLimitRetryDelayMinutes: true,
      recoveryDeliveryMarketingRetryDelayMinutes: true,
      recoveryDeliveryMaxRetries: true,
    },
  });
  const decision = decideRecoveryOutreachRetry(input.providerFailureCode, input.failedAt, config);
  const intent = await tx.recoveryOutreachRetryIntent.upsert({
    where: { failedAttemptId: input.attemptId },
    create: {
      failedAttemptId: input.attemptId,
      failedMessageId: input.messageId,
      fundingReservationId: input.reservationId,
      providerFailureCode: input.providerFailureCode,
      ...decision,
      expectedGeneration: input.expectedGeneration,
      expectedLastExternalActivityAt: input.expectedLastExternalActivityAt,
    },
    update: {},
    select: { id: true, failedMessageId: true, fundingReservationId: true, providerFailureCode: true, cancelledAt: true },
  });
  requireLineage(intent.failedMessageId === input.messageId && intent.fundingReservationId === input.reservationId,
    "retry decision immutable identity mismatch");
  // A v3 receipt can enrich an earlier code-less FAILED receipt. Keep the
  // same identity and original failure clock; never revive a cancelled plan.
  if (intent.providerFailureCode === null && input.providerFailureCode !== null && !intent.cancelledAt) {
    const enriched = await tx.recoveryOutreachRetryIntent.updateMany({
      where: { id: intent.id, providerFailureCode: null, cancelledAt: null },
      data: { providerFailureCode: input.providerFailureCode, ...decision },
    });
    requireLineage(enriched.count === 1, "retry decision enrichment conflict");
  }
}
