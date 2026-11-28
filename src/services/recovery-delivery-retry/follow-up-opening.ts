import { Prisma, type PrismaClient } from "@prisma/client";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { initialOutreachDiagnostic } from "./error-diagnostic.js";
import {
  isReplayableRecoveryTransactionError,
  recoveryTransactionBackoffMs,
  waitForRecoveryTransactionReplay,
} from "./transaction-resilience.js";
import { createHash } from "node:crypto";
import { retryOutreachAttemptId } from "../../domain/recovery-outreach-identity.js";
import { followUpRetryBlockId } from "../../domain/recovery-follow-up-retry-allowance.js";
import { classifyFollowUpRetryOpening } from "../../domain/recovery-follow-up-retry-outcome.js";
import { lockRecoveryContext } from "../recovery-conversation/recovery-conversation.sql.js";
import { readReservedRecoveryFunding } from "../recovery-billing/reserved-recovery-funding.js";
import { readExactAutomatedUsage } from "../recovery-delivery-compensation/automated-usage.js";
import { requireLineage } from "../recovery-delivery-compensation/types.js";
import type { DispatchPermit } from "../recovery-conversation/outbound-send-fence.service.js";
import {
  scheduledFollowUpRetryOwnerDenial,
  scheduledFollowUpRetryClaimKey,
  type ScheduledFollowUpRetryScope,
} from "./follow-up-eligibility.js";
import { inspectScheduledFollowUpRetryLineage } from "./follow-up-lineage.js";
import { followUpRetryDispatchKey } from "./follow-up-permit.js";

type Scope = ScheduledFollowUpRetryScope;
type Prepared =
  | { kind: "prepared"; messageId: string; sourceKey: string }
  | { kind: "held"; reason: string };
const held = (reason: string): Prepared => ({ kind: "held", reason });
const openingId = (attemptId: string) =>
  `followup-retry-${createHash("sha256").update(attemptId).digest("hex")}`;

/** Own only the retry opener. Ordinary reservations must never consume this
 * pending allowance. Create message + exact outbound usage atomically, and
 * replay the immutable body only before the provider permit. */
export class ScheduledFollowUpRetryOpeningService {
  constructor(
    private readonly db: Pick<PrismaClient, "$transaction">,
    private readonly clock = () => new Date(),
    private readonly log?: StructuredLogger,
  ) {}

  async prepare(scope: Scope, content: string): Promise<Prepared> {
    return this.db.$transaction(
      async (tx): Promise<Prepared> => {
        const owner = await lockRecoveryContext(tx, scope.conversationId);
        if (
          !owner ||
          owner.shopId !== scope.shopId ||
          owner.recoveryId !== scope.recoveryId
        )
          return held("owner-changed");
        const locked = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM commerce."CheckoutRecovery" WHERE id=${scope.recoveryId} FOR UPDATE`;
        if (locked.length !== 1) return held("recovery-missing");
        const now = this.clock();
        const denial = await scheduledFollowUpRetryOwnerDenial(
          tx,
          scope,
          owner,
          now,
        );
        if (denial) return held(denial);
        const attemptId = retryOutreachAttemptId(scope.intentId);
        const blockId = followUpRetryBlockId(attemptId);
        const messageId = openingId(attemptId);
        const attempt = await tx.recoveryOutreachAttempt.findUnique({
          where: { id: attemptId },
        });
        if (
          !attempt ||
          attempt.checkoutRecoveryId !== scope.recoveryId ||
          attempt.sequence < 3 ||
          attempt.trigger !== "NO_RESPONSE_FOLLOW_UP" ||
          attempt.initiatedBy !== "AUTOMATION" ||
          attempt.initiationKey !==
            scheduledFollowUpRetryClaimKey(scope.intentId) ||
          !attempt.claimedAt ||
          attempt.status !== "PENDING" ||
          attempt.outboundMessageId ||
          attempt.sentAt ||
          attempt.closedAt ||
          attempt.failureCode ||
          attempt.followUpDueAt ||
          attempt.customerRespondedAt
        )
          return held("claim-not-clean");
        const block = await tx.conversationAllowanceBlock.findUnique({
          where: { id: blockId },
        });
        if (
          !block ||
          block.shopId !== scope.shopId ||
          block.conversationId !== owner.id ||
          block.state !== "PENDING"
        )
          return held("block-unavailable");
        const message = await tx.conversationMessage.findUnique({
          where: { id: messageId },
        });
        const usageKey = `recovery-outreach:${attemptId}`;
        const usage = await tx.usageEvent.findUnique({
          where: { idempotencyKey: usageKey },
        });
        const recovery = await tx.checkoutRecovery.findUniqueOrThrow({
          where: { id: scope.recoveryId },
          select: { shop: { select: { platform: true } } },
        });
        if (
          message &&
          (message.conversationId !== owner.id ||
            message.allowanceBlockId !== blockId ||
            message.direction !== "OUTBOUND" ||
            message.senderType !== "AUTOMATION" ||
            message.content !== content ||
            message.outboundPresentation !== null ||
            message.inReplyToProviderId ||
            classifyFollowUpRetryOpening(
              message,
              followUpRetryDispatchKey(attemptId),
            ) !== "prepared" ||
            !usage ||
            usage.shopId !== scope.shopId ||
            usage.provider !== recovery.shop.platform ||
            usage.sourceId !== message.id ||
            (await readExactAutomatedUsage(tx, scope.shopId, message.id))
              ?.id !== usage.id)
        )
          return held("prepared-opening-conflict");
        if (!message && usage) return held("opening-usage-conflict");
        const funding = await readReservedRecoveryFunding(
          tx,
          {
            ...scope,
            outreachAttemptId: attemptId,
            outboundMessageId: message?.id ?? null,
          },
          true,
          now,
          () => {},
        );
        if (
          funding.kind !== "admitted" ||
          funding.reservationId !== block.creditReservationId
        )
          return held("funding-unavailable");
        const lineage = await inspectScheduledFollowUpRetryLineage(tx, {
          ...scope,
          now,
          fundedReservationId: funding.reservationId,
          ...(message ? { preparedMessageId: message.id } : {}),
        });
        if (
          lineage.kind !== "proven" ||
          lineage.plan.kind !== "existing" ||
          lineage.plan.attemptId !== attemptId ||
          lineage.fundedBlockId !== blockId
        )
          return held("funded-lineage-unavailable");
        if (!message) {
          await tx.conversationMessage.create({
            data: {
              id: messageId,
              conversationId: owner.id,
              allowanceBlockId: blockId,
              direction: "OUTBOUND",
              senderType: "AUTOMATION",
              status: "PENDING",
              content,
            },
          });
          await tx.usageEvent.create({
            data: {
              shopId: scope.shopId,
              metric: "OUTBOUND_AUTOMATED_MESSAGE",
              quantity: 1,
              provider: recovery.shop.platform,
              billingPeriodId:
                "billingPeriod" in funding.admission.policy
                  ? (funding.admission.policy.billingPeriod?.id ?? null)
                  : null,
              idempotencyKey: usageKey,
              sourceType: "OUTBOUND_AUTOMATED_MESSAGE",
              sourceId: messageId,
            },
          });
        }
        return {
          kind: "prepared",
          messageId,
          sourceKey: funding.admission.sourceKey,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /** Explicit refusal before a permit. An unknown or already admitted request
   * is never changed by this method; the reconciler owns release of credit. */
  async refuse(scope: Scope, messageId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const owner = await lockRecoveryContext(tx, scope.conversationId);
      if (
        !owner ||
        owner.shopId !== scope.shopId ||
        owner.recoveryId !== scope.recoveryId
      )
        return;
      const attemptId = retryOutreachAttemptId(scope.intentId);
      if (messageId !== openingId(attemptId)) return;
      await tx.conversationMessage.updateMany({
        where: {
          id: messageId,
          conversationId: owner.id,
          allowanceBlockId: followUpRetryBlockId(attemptId),
          direction: "OUTBOUND",
          senderType: "AUTOMATION",
          status: "PENDING",
          providerDispatchKey: null,
          providerDispatchAdmittedAt: null,
          providerDispatchControlRevision: null,
          dispatchProviderAccountId: null,
          dispatchProviderPhoneNumberId: null,
          providerMessageId: null,
          sentAt: null,
          deliveredAt: null,
          readAt: null,
          failedAt: null,
          providerFailureCode: null,
        },
        data: { status: "FAILED" },
      });
    });
  }

  /** Persist the actual outcome independently of present-day eligibility. Do
   * not call the transport from a transaction or replay it on SQL failure. */
  async record(
    scope: Scope,
    permit: Extract<DispatchPermit, { kind: "admitted" }>,
    outcome:
      | { kind: "accepted"; providerMessageId: string }
      | { kind: "rejected"; providerCode: string | null },
  ): Promise<void> {
    // Only replay receipt persistence, never the permit or HTTP request.
    for (let n = 1; n <= 3; n++) {
      try {
        await this.recordOnce(scope, permit, outcome);
        return;
      } catch (error) {
        if (n === 3 || !isReplayableRecoveryTransactionError(error))
          throw error;
        const retryBackoffMs = recoveryTransactionBackoffMs(n, error);
        this.log?.warn(
          "recovery.delivery_retry.follow_up_receipt_persistence_retry",
          {
            retryIntentId: scope.intentId,
            outboundMessageId: permit.messageId,
            transactionAttempt: n,
            retryBackoffMs,
            sourceError: initialOutreachDiagnostic(error),
          },
        );
        await waitForRecoveryTransactionReplay(retryBackoffMs);
      }
    }
  }

  private async recordOnce(
    scope: Scope,
    permit: Extract<DispatchPermit, { kind: "admitted" }>,
    outcome:
      | { kind: "accepted"; providerMessageId: string }
      | { kind: "rejected"; providerCode: string | null },
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const owner = await lockRecoveryContext(tx, scope.conversationId);
      requireLineage(
        owner &&
          owner.shopId === scope.shopId &&
          owner.recoveryId === scope.recoveryId,
        "follow-up outcome owner mismatch",
      );
      const attemptId = retryOutreachAttemptId(scope.intentId);
      requireLineage(
        permit.messageId === openingId(attemptId) &&
          permit.dispatchKey === followUpRetryDispatchKey(attemptId),
        "follow-up outcome permit mismatch",
      );
      const message = await tx.conversationMessage.findUniqueOrThrow({
        where: { id: permit.messageId },
      });
      requireLineage(
        message.conversationId === owner.id &&
          message.allowanceBlockId === followUpRetryBlockId(attemptId) &&
          message.direction === "OUTBOUND" &&
          message.senderType === "AUTOMATION" &&
          message.providerDispatchKey === permit.dispatchKey &&
          message.providerDispatchAdmittedAt?.getTime() ===
            permit.admittedAt.getTime() &&
          message.dispatchProviderAccountId ===
            permit.sender.providerAccountId &&
          message.dispatchProviderPhoneNumberId ===
            permit.sender.providerPhoneNumberId,
        "follow-up outcome message mismatch",
      );
      if (
        outcome.kind === "accepted" &&
        message.providerMessageId === outcome.providerMessageId &&
        message.sentAt
      )
        return;
      const rejectionCode =
        outcome.kind === "rejected"
          ? (outcome.providerCode ?? "PROVIDER_REJECTED")
          : null;
      if (
        outcome.kind === "rejected" &&
        message.status === "FAILED" &&
        message.failedAt &&
        !message.providerMessageId &&
        message.providerFailureCode === rejectionCode
      ) {
        const attempt = await tx.recoveryOutreachAttempt.findUnique({
          where: { id: attemptId },
        });
        requireLineage(
          attempt?.outboundMessageId === message.id &&
            attempt.status === "FAILED" &&
            attempt.failureCode ===
              (rejectionCode === "131026"
                ? "WHATSAPP_RECIPIENT_UNDELIVERABLE"
                : "PROVIDER_REJECTED"),
          "follow-up rejection replay conflict",
        );
        return;
      }
      const now = this.clock();
      const changed = await tx.conversationMessage.updateMany({
        where: {
          id: message.id,
          status: "PENDING",
          providerMessageId: null,
          providerDispatchKey: permit.dispatchKey,
          sentAt: null,
          deliveredAt: null,
          readAt: null,
          failedAt: null,
          providerFailureCode: null,
        },
        data:
          outcome.kind === "accepted"
            ? {
                status: "SENT",
                sentAt: now,
                providerMessageId: outcome.providerMessageId,
              }
            : {
                status: "FAILED",
                failedAt: now,
                providerFailureCode: rejectionCode,
              },
      });
      requireLineage(
        changed.count === 1,
        "follow-up outcome transition conflict",
      );
      if (outcome.kind === "accepted") {
        await tx.conversation.updateMany({
          where: {
            id: owner.id,
            OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: now } }],
          },
          data: { lastMessageAt: now },
        });
      } else {
        const attempt = await tx.recoveryOutreachAttempt.updateMany({
          where: {
            id: attemptId,
            checkoutRecoveryId: scope.recoveryId,
            trigger: "NO_RESPONSE_FOLLOW_UP",
            initiatedBy: "AUTOMATION",
            initiationKey: scheduledFollowUpRetryClaimKey(scope.intentId),
            status: { in: ["PENDING", "CANCELLED"] },
            outboundMessageId: null,
            sentAt: null,
          },
          data: {
            status: "FAILED",
            outboundMessageId: message.id,
            failureCode:
              outcome.providerCode === "131026"
                ? "WHATSAPP_RECIPIENT_UNDELIVERABLE"
                : "PROVIDER_REJECTED",
            closedAt: now,
          },
        });
        requireLineage(
          attempt.count === 1,
          "follow-up rejection attempt mismatch",
        );
      }
    });
  }
}
