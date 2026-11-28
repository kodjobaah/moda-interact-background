import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { isInitialRetryId } from "../../domain/recovery-outreach-identity.js";
import { followUpRetryBlockId } from "../../domain/recovery-follow-up-retry-allowance.js";
import type { WhatsAppSenderIdentity } from "../../integration/whatsapp/types.js";
import type { RecoveryContext } from "../recovery-conversation/recovery-conversation.sql.js";
import {
  ExistingHoldSignal,
  readReservedRecoveryFunding,
} from "../recovery-billing/reserved-recovery-funding.js";
import { readExactAutomatedUsage } from "../recovery-delivery-compensation/automated-usage.js";
import { RecoveryCompensationLineageError } from "../recovery-delivery-compensation/types.js";
import {
  scheduledFollowUpRetryOwnerDenial,
  readScheduledFollowUpRetrySender,
  scheduledFollowUpRetryClaimKey,
} from "./follow-up-eligibility.js";
import { inspectScheduledFollowUpRetryLineage } from "./follow-up-lineage.js";
import { initialOutreachDiagnostic } from "./error-diagnostic.js";

const log = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});
export type FollowUpRetryPermitInput = {
  shopId: string;
  recoveryId: string;
  conversationId: string;
  attemptId: string;
  messageId: string;
  recipient: string;
  expectedContent: string;
  sourceKey: string;
  now: Date;
};
export type FollowUpRetryPermitCheck =
  | {
      kind: "ready";
      sender: WhatsAppSenderIdentity;
      blockId: string;
      dispatchKey: string;
    }
  | { kind: "held"; reason: string };

/** Stable per physical retry on either commerce platform, not per message. */
export const followUpRetryDispatchKey = (attemptId: string) =>
  `recovery-follow-up-retry-${createHash("sha256").update(attemptId).digest("hex")}`;

/** SQL-only readiness proof for the explicit follow-up retry branch of the
 * shared send fence. Caller holds the Shop -> Conversation locks. It must
 * additionally perform the common stored consent, registered template and
 * current sender/config checks and write the unique provider permit. This
 * function does NOT dispatch, reserve, release, commit or activate anything. */
export async function checkScheduledFollowUpRetryPermit(
  tx: Prisma.TransactionClient,
  owner: RecoveryContext,
  input: FollowUpRetryPermitInput,
  logger: StructuredLogger = log,
): Promise<FollowUpRetryPermitCheck> {
  const fields = {
    shopId: input.shopId,
    checkoutRecoveryId: input.recoveryId,
    conversationId: input.conversationId,
    outreachAttemptId: input.attemptId,
    outboundMessageId: input.messageId,
    retryIntentId: input.attemptId.slice("retry_".length),
  };
  const held = (reason: string, error?: unknown): FollowUpRetryPermitCheck => {
    logger.debug("recovery.delivery_retry.follow_up_permit_held", {
      ...fields,
      reason,
      ...(error === undefined
        ? {}
        : { sourceError: initialOutreachDiagnostic(error) }),
    });
    return { kind: "held", reason };
  };
  if (
    !isInitialRetryId(input.attemptId) ||
    !input.messageId ||
    !input.expectedContent.trim() ||
    !input.sourceKey ||
    !Number.isFinite(input.now.getTime()) ||
    owner.id !== input.conversationId ||
    owner.shopId !== input.shopId ||
    owner.recoveryId !== input.recoveryId
  )
    return held("invalid-follow-up-retry-scope");
  const scope = {
    shopId: input.shopId,
    recoveryId: input.recoveryId,
    conversationId: input.conversationId,
    intentId: fields.retryIntentId,
  };
  try {
    const locked = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM commerce."CheckoutRecovery" WHERE id=${input.recoveryId} FOR UPDATE`;
    if (locked.length !== 1) return held("retry-recovery-missing");
    await tx.$queryRaw`SELECT id FROM public."BackgroundRuntimeConfig" WHERE id='default' FOR SHARE`;
    const denial = await scheduledFollowUpRetryOwnerDenial(
      tx,
      scope,
      owner,
      input.now,
    );
    if (denial) return held(denial);
    const attempt = await tx.recoveryOutreachAttempt.findUnique({
      where: { id: input.attemptId },
    });
    if (
      !attempt ||
      attempt.checkoutRecoveryId !== input.recoveryId ||
      attempt.sequence < 3 ||
      attempt.trigger !== "NO_RESPONSE_FOLLOW_UP" ||
      attempt.initiatedBy !== "AUTOMATION" ||
      attempt.initiationKey !==
        scheduledFollowUpRetryClaimKey(scope.intentId) ||
      !attempt.claimedAt ||
      attempt.status !== "PENDING" ||
      attempt.recipient !== input.recipient ||
      attempt.closedAt ||
      attempt.failureCode ||
      attempt.followUpDueAt ||
      attempt.outboundMessageId ||
      attempt.sentAt ||
      attempt.customerRespondedAt
    )
      return held("retry-claim-not-clean");
    const funding = await readReservedRecoveryFunding(
      tx,
      {
        ...scope,
        outreachAttemptId: attempt.id,
        outboundMessageId: input.messageId,
      },
      true,
      input.now,
      () => {},
    );
    if (funding.kind !== "admitted")
      return held(
        funding.kind === "held" ? `credit:${funding.reason}` : "credit:missing",
      );
    if (funding.admission.sourceKey !== input.sourceKey)
      return held("retry-reservation-mismatch");
    const limits = funding.admission.policy;
    if (
      !Number.isSafeInteger(limits.outboundHardLimit) ||
      !Number.isSafeInteger(limits.terminalMessageReservedSlots) ||
      limits.terminalMessageReservedSlots < 0 ||
      limits.outboundHardLimit <= limits.terminalMessageReservedSlots
    )
      return held("retry-normal-capacity-unavailable");
    const inspected = await inspectScheduledFollowUpRetryLineage(tx, {
      ...scope,
      now: input.now,
      fundedReservationId: funding.reservationId,
      preparedMessageId: input.messageId,
    });
    if (inspected.kind === "held") return held(inspected.reason);
    const { plan, fundedBlockId } = inspected;
    if (
      plan.kind !== "existing" ||
      plan.attemptId !== attempt.id ||
      plan.recipient !== input.recipient ||
      fundedBlockId !== followUpRetryBlockId(attempt.id)
    )
      return held("retry-current-claim-unavailable");
    const history = await tx.recoveryOutreachAttempt.findMany({
      where: { id: { in: plan.links.map((link) => link.predecessor.id) } },
      select: { id: true, claimedAt: true, initiationKey: true },
    });
    const historical = new Map(history.map((row) => [row.id, row]));
    if (
      plan.links.some((link, index) => {
        const row = historical.get(link.predecessor.id);
        const key =
          index === 0
            ? `scheduled-no-response:${input.recoveryId}`
            : scheduledFollowUpRetryClaimKey(plan.links[index - 1]!.intent.id);
        return !row?.claimedAt || row.initiationKey !== key;
      })
    )
      return held("scheduled-claim-identity");
    const message = await tx.conversationMessage.findUnique({
      where: { id: input.messageId },
      include: {
        recoveryOutreachAttempt: { select: { id: true } },
        merchantSendCommand: { select: { id: true } },
        _count: { select: { deliveryParts: true } },
      },
    });
    if (
      !message ||
      message.conversationId !== input.conversationId ||
      message.allowanceBlockId !== fundedBlockId ||
      message.direction !== "OUTBOUND" ||
      message.senderType !== "AUTOMATION" ||
      message.status !== "PENDING" ||
      message.content !== input.expectedContent ||
      message.inReplyToProviderId ||
      message.outboundPresentation !== null ||
      message.recoveryOutreachAttempt ||
      message.merchantSendCommand ||
      message._count.deliveryParts ||
      message.providerDispatchKey ||
      message.providerDispatchAdmittedAt ||
      message.providerDispatchControlRevision !== null ||
      message.dispatchProviderAccountId ||
      message.dispatchProviderPhoneNumberId ||
      message.providerMessageId ||
      message.sentAt ||
      message.deliveredAt ||
      message.readAt ||
      message.failedAt ||
      message.providerFailureCode
    )
      return held("retry-prepared-message-mismatch");
    const usage = await tx.usageEvent.findUnique({
      where: { idempotencyKey: `recovery-outreach:${attempt.id}` },
    });
    if (
      !usage ||
      usage.shopId !== input.shopId ||
      usage.sourceId !== message.id ||
      usage.metric !== "OUTBOUND_AUTOMATED_MESSAGE" ||
      usage.sourceType !== "OUTBOUND_AUTOMATED_MESSAGE" ||
      Number(usage.quantity) !== 1 ||
      (await readExactAutomatedUsage(tx, input.shopId, message.id))?.id !==
        usage.id
    )
      return held("retry-outbound-usage-mismatch");
    const dispatchKey = followUpRetryDispatchKey(attempt.id);
    if (
      await tx.conversationMessage.findUnique({
        where: { providerDispatchKey: dispatchKey },
        select: { id: true },
      })
    )
      return held("already-admitted-or-sent");
    const sender = await readScheduledFollowUpRetrySender(
      tx,
      scope,
      input.recipient,
      plan.links.map((link) => link.intent.failedMessageId),
      input.now,
    );
    if (!sender) return held("sender-identity-changed");
    return { kind: "ready", blockId: fundedBlockId, sender, dispatchKey };
  } catch (error) {
    if (
      error instanceof RecoveryCompensationLineageError ||
      error instanceof ExistingHoldSignal
    )
      return held(
        error instanceof ExistingHoldSignal
          ? `credit:${error.reason}`
          : "retry-policy-or-funding-lineage",
        error instanceof ExistingHoldSignal && error.original
          ? error.original
          : error,
      );
    logger.error("recovery.delivery_retry.follow_up_permit_failed", {
      ...fields,
      sourceError: initialOutreachDiagnostic(error),
    });
    throw error;
  }
}
