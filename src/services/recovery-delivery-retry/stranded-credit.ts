import { Prisma, type PrismaClient } from "@prisma/client";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import {
  isInitialOutreachIdentity,
  isInitialRetryId,
} from "../../domain/recovery-outreach-identity.js";
import { lockRecoveryContext } from "../recovery-conversation/recovery-conversation.sql.js";
import { findExactRecoveryReservationSource } from "../recovery-delivery-compensation/lineage.js";
import {
  readExactAutomatedUsage,
  removeExactAutomatedUsage,
} from "../recovery-delivery-compensation/automated-usage.js";
import { releaseReservedSource } from "../recovery-delivery-compensation/reserved.js";
import { requireLineage } from "../recovery-delivery-compensation/types.js";
import { readRetryFundingLineage } from "./funding-lineage.js";
import { initialOutreachDiagnostic } from "./error-diagnostic.js";
import {
  isReplayableRecoveryTransactionError,
  recoveryTransactionBackoffMs,
  transactionFailureDetails,
  waitForRecoveryTransactionReplay,
} from "./transaction-resilience.js";

const logger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});
type Scope = {
  shopId: string;
  recoveryId: string;
  outreachAttemptId: string;
  conversationId: string;
};
type Result =
  | { kind: "held"; reason: string }
  | { kind: "cancelled"; reason: string; reservationId: string | null };
const held = (reason: string): Result => ({ kind: "held", reason });

/** Reclaim only provably unsent, permanently obsolete retry work. A temporary
 * denial (policy, capacity, consent unavailable, stale offer, lock conflict)
 * is not permission to release a reservation or terminalize an attempt.
 * Caller holds the existing checkout lease; SQL owner locks and the final
 * provider permit also serialize this decision against any competing send.
 * No provider I/O is performed, including when replaying a lost commit ack. */
export async function reclaimStrandedRetryCredit(
  db: Pick<PrismaClient, "$transaction">,
  scope: Scope,
  log: StructuredLogger = logger,
): Promise<Result> {
  const retryIntentId = scope.outreachAttemptId.slice("retry_".length);
  const fields = {
    shopId: scope.shopId,
    checkoutRecoveryId: scope.recoveryId,
    conversationId: scope.conversationId,
    outreachAttemptId: scope.outreachAttemptId,
    retryIntentId,
  };
  if (!isInitialRetryId(scope.outreachAttemptId))
    return held("invalid-retry-identity");
  for (let n = 1; n <= 3; n++) {
    try {
      const result = await db.$transaction(
        async (tx) => {
          const owner = await lockRecoveryContext(tx, scope.conversationId, {
            shopId: scope.shopId,
            recoveryId: scope.recoveryId,
            contention: "nowait",
          });
          if (!owner) return held("cleanup-owner-mismatch");
          const locked = await tx.$queryRaw<
            Array<{ id: string }>
          >`SELECT id FROM commerce."CheckoutRecovery" WHERE id=${scope.recoveryId} FOR UPDATE NOWAIT`;
          if (locked.length !== 1) return held("cleanup-owner-missing");
          const recovery = await tx.checkoutRecovery.findUniqueOrThrow({
            where: { id: scope.recoveryId },
            select: {
              shopId: true,
              checkoutToken: true,
              generation: true,
              lastExternalActivityAt: true,
              status: true,
              completedAt: true,
              expiredAt: true,
            },
          });
          const attempt = await tx.recoveryOutreachAttempt.findUnique({
            where: { id: scope.outreachAttemptId },
            include: { deliveryRetryIntent: { select: { id: true } } },
          });
          if (
            !attempt ||
            !isInitialOutreachIdentity(attempt) ||
            attempt.checkoutRecoveryId !== scope.recoveryId ||
            recovery.shopId !== scope.shopId ||
            !["PENDING", "CAPACITY_BLOCKED", "CANCELLED"].includes(
              attempt.status,
            ) ||
            attempt.sentAt ||
            attempt.outboundMessageId ||
            attempt.customerRespondedAt ||
            attempt.deliveryRetryIntent
          )
            return held("cleanup-not-unsent-claim");
          await readRetryFundingLineage(tx, {
            recoveryId: scope.recoveryId,
            conversationId: scope.conversationId,
            attemptId: attempt.id,
          });
          const intent = await tx.recoveryOutreachRetryIntent.findUniqueOrThrow(
            { where: { id: retryIntentId } },
          );
          const reason = intent.cancelledAt
            ? "intent-cancelled"
            : recovery.completedAt ||
                recovery.expiredAt ||
                ["COMPLETED", "EXPIRED", "CANCELLED", "ENGAGED"].includes(
                  recovery.status,
                )
              ? "recovery-terminal-or-engaged"
              : intent.expectedGeneration !== recovery.generation ||
                  intent.expectedLastExternalActivityAt.getTime() !==
                    recovery.lastExternalActivityAt.getTime()
                ? "checkout-changed"
                : owner.inboundVersion > 0 || owner.lastInboundAt
                  ? "customer-responded"
                  : (await tx.checkoutRecovery.findFirst({
                        where: {
                          shopId: scope.shopId,
                          checkoutToken: recovery.checkoutToken,
                          generation: { gt: recovery.generation },
                        },
                        select: { id: true },
                      }))
                    ? "newer-generation"
                    : null;
          if (!reason) return held("cleanup-not-terminal");
          const source = await findExactRecoveryReservationSource(
            tx,
            scope.shopId,
            attempt.id,
          );
          if (
            source &&
            (!["RESERVED", "RELEASED"].includes(source.reservation.status) ||
              source.reservation.committedUsageEventId ||
              source.reservation.compensationUsageEventId ||
              source.reservation.compensatedAt ||
              (await tx.conversationAllowanceBlock.count({
                where: { creditReservationId: source.reservation.id },
              })))
          )
            return held("cleanup-funded-or-ambiguous");
          const usage = await tx.usageEvent.findUnique({
            where: { idempotencyKey: `recovery-outreach:${attempt.id}` },
          });
          if (usage) {
            if (
              !usage.sourceId ||
              usage.shopId !== scope.shopId ||
              usage.metric !== "OUTBOUND_AUTOMATED_MESSAGE" ||
              usage.sourceType !== "OUTBOUND_AUTOMATED_MESSAGE" ||
              Number(usage.quantity) !== 1
            )
              return held("cleanup-usage-mismatch");
            const message = await tx.conversationMessage.findUnique({
              where: { id: usage.sourceId },
              include: {
                recoveryOutreachAttempt: { select: { id: true } },
                merchantSendCommand: { select: { id: true } },
                _count: { select: { deliveryParts: true } },
              },
            });
            // A provider permit, even without a receipt, must never be cleared.
            if (
              !message ||
              message.conversationId !== scope.conversationId ||
              message.direction !== "OUTBOUND" ||
              message.senderType !== "AUTOMATION" ||
              message.recoveryOutreachAttempt ||
              message.merchantSendCommand ||
              message.allowanceBlockId ||
              message._count.deliveryParts > 0 ||
              !["PENDING", "FAILED"].includes(message.status) ||
              message.providerDispatchKey ||
              message.providerDispatchAdmittedAt ||
              message.providerDispatchControlRevision !== null ||
              message.providerMessageId ||
              message.sentAt ||
              message.deliveredAt ||
              message.readAt ||
              message.failedAt ||
              message.providerFailureCode
            )
              return held("cleanup-provider-outcome-uncertain");
            const exact = await readExactAutomatedUsage(
              tx,
              scope.shopId,
              message.id,
            );
            requireLineage(
              exact?.id === usage.id,
              "retry cleanup usage mismatch",
            );
            const changed = await tx.conversationMessage.updateMany({
              where: {
                id: message.id,
                status: message.status,
                providerDispatchKey: null,
                providerDispatchAdmittedAt: null,
                providerDispatchControlRevision: null,
                providerMessageId: null,
                sentAt: null,
                deliveredAt: null,
                readAt: null,
                failedAt: null,
                providerFailureCode: null,
              },
              data: { status: "FAILED" },
            });
            requireLineage(
              changed.count === 1,
              "retry cleanup message changed",
            );
            // Retain the prepared message as historical evidence, and remove only its provisional usage.
            await removeExactAutomatedUsage(
              tx,
              scope.shopId,
              message.id,
              exact,
            );
            const closed = await tx.recoveryOutreachAttempt.updateMany({
              where: {
                id: attempt.id,
                status: attempt.status,
                sentAt: null,
                outboundMessageId: null,
              },
              data: {
                status: "FAILED",
                outboundMessageId: message.id,
                failureCode: "PRE_PROVIDER_REFUSED",
                closedAt: new Date(),
                followUpDueAt: null,
              },
            });
            requireLineage(closed.count === 1, "retry cleanup attempt changed");
          } else {
            // With no exact usage, do not infer ownership of an unlinked outbound.
            if (
              await tx.conversationMessage.findFirst({
                where: {
                  conversationId: scope.conversationId,
                  direction: "OUTBOUND",
                  senderType: "AUTOMATION",
                  recoveryOutreachAttempt: null,
                },
                select: { id: true },
              })
            )
              return held("cleanup-unlinked-outbound");
            if (
              attempt.status === "CANCELLED" &&
              intent.cancelledAt &&
              (!source || source.reservation.status === "RELEASED")
            )
              return held("cleanup-already-cancelled");
            const closed = await tx.recoveryOutreachAttempt.updateMany({
              where: {
                id: attempt.id,
                status: attempt.status,
                sentAt: null,
                outboundMessageId: null,
              },
              data: {
                status: "CANCELLED",
                closedAt: attempt.closedAt ?? new Date(),
                followUpDueAt: null,
              },
            });
            requireLineage(closed.count === 1, "retry cleanup attempt changed");
          }
          if (!intent.cancelledAt)
            await tx.recoveryOutreachRetryIntent.updateMany({
              where: { id: intent.id, cancelledAt: null },
              data: { cancelledAt: new Date() },
            });
          if (source?.reservation.status === "RESERVED")
            await releaseReservedSource(tx, source);
          return {
            kind: "cancelled",
            reason,
            reservationId: source?.reservation.id ?? null,
          } as const;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      if (result.kind === "cancelled")
        log.info("recovery.delivery_retry.stranded_credit_reconciled", {
          ...fields,
          reason: result.reason,
          fundingReservationId: result.reservationId,
        });
      return result;
    } catch (error) {
      const data = {
        ...fields,
        transactionAttempt: n,
        ...transactionFailureDetails(error),
        sourceError: initialOutreachDiagnostic(error),
      };
      if (n < 3 && isReplayableRecoveryTransactionError(error)) {
        const retryBackoffMs = recoveryTransactionBackoffMs(n, error);
        log.warn("recovery.delivery_retry.stranded_credit_conflict", {
          ...data,
          retryBackoffMs,
        });
        await waitForRecoveryTransactionReplay(retryBackoffMs);
        continue;
      }
      log.error("recovery.delivery_retry.stranded_credit_failed", data);
      throw error;
    }
  }
  throw new Error("Unreachable stranded credit reconciliation state");
}
