import { Prisma, type PrismaClient } from "@prisma/client";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { planInitialRetryClaim } from "../../domain/recovery-retry-claim.js";
import { lockRecoveryContext } from "../recovery-conversation/recovery-conversation.sql.js";
import { isCheckoutRecoveryWithinLifetime } from "../recovery-lifetime/checkout-recovery-lifetime.js";
import { RecoveryCompensationLineageError } from "../recovery-delivery-compensation/types.js";
import { retryFundingIdentitySelect } from "./funding-lineage.js";
import { requireInitialRetryPredecessorReady } from "./funding.js";
import { initialOutreachDiagnostic } from "./error-diagnostic.js";
import {
  RecoveryTransactionTiming,
  isReplayableRecoveryTransactionError,
  recoveryTransactionBackoffMs,
  transactionFailureDetails,
  waitForRecoveryTransactionReplay,
} from "./transaction-resilience.js";
import type { RecoveryPolicySnapshot } from "../recovery-policy.service.js";

const logger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});
type Tx = Prisma.TransactionClient;
type Database = Pick<
  PrismaClient,
  "$transaction" | "recoveryOutreachRetryIntent"
>;
type Cursor = { notBeforeAt: Date; id: string };
type ClaimLogContext = {
  stage: string;
  fields: Record<string, unknown>;
  timing: RecoveryTransactionTiming;
};
export type RetryClaimResult =
  | {
      kind: "ready" | "claimed" | "existing";
      attemptId: string;
      sequence: number;
      recoveryId: string;
      conversationId: string;
    }
  | { kind: "held"; reason: string };
const held = (reason: string): RetryClaimResult => ({ kind: "held", reason });

/** Bounded keyset scan of durable candidates. A due timestamp does not grant
 * permission. Re-scan from the beginning on the next sweep; do not use Redis
 * as the source of truth or omit already claimed intents after a crash. */
export async function listDueInitialRetryIntents(
  db: Pick<Database, "recoveryOutreachRetryIntent">,
  input: {
    now: Date;
    limit: number;
    after?: Cursor;
  },
  serviceLogger: StructuredLogger = logger,
) {
  if (
    !Number.isFinite(input.now.getTime()) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 250 ||
    (input.after &&
      (!input.after.id || !Number.isFinite(input.after.notBeforeAt.getTime())))
  ) {
    const error = new RangeError(
      "Invalid recovery retry discovery cursor or batch size",
    );
    serviceLogger.error("recovery.delivery_retry.discovery_failed", {
      reason: "invalid-discovery-input",
      sourceError: initialOutreachDiagnostic(error),
    });
    throw error;
  }
  const fields = {
    evaluationAt: input.now.toISOString(),
    limit: input.limit,
    afterIntentId: input.after?.id,
  };
  try {
    const rows = await db.recoveryOutreachRetryIntent.findMany({
      where: {
        policy: "AFTER_COOLDOWN",
        cancelledAt: null,
        notBeforeAt: { lte: input.now },
        failedAttempt: { trigger: "INITIAL", status: "FAILED" },
        ...(input.after
          ? {
              OR: [
                { notBeforeAt: { gt: input.after.notBeforeAt } },
                {
                  notBeforeAt: input.after.notBeforeAt,
                  id: { gt: input.after.id },
                },
              ],
            }
          : {}),
      },
      select: { id: true, notBeforeAt: true },
      orderBy: [{ notBeforeAt: "asc" }, { id: "asc" }],
      take: input.limit,
    });
    // One bounded diagnostic per nonempty page, not one event per row or idle poll.
    if (rows.length)
      serviceLogger.debug("recovery.delivery_retry.discovered", {
        ...fields,
        count: rows.length,
        firstIntentId: rows[0]?.id,
        lastIntentId: rows.at(-1)?.id,
      });
    return rows;
  } catch (error) {
    serviceLogger.error("recovery.delivery_retry.discovery_failed", {
      ...fields,
      sourceError: initialOutreachDiagnostic(error),
    });
    throw error;
  }
}

/** A durable claim is not provider permission. Execution must still perform
 * eligibility, consent, offer refresh and the final provider send fence. */
export class InitialDeliveryRetryClaimService {
  constructor(
    private readonly database: Database,
    private readonly clock: () => Date = () => new Date(),
    private readonly serviceLogger: StructuredLogger = logger,
  ) {}

  inspect(intentId: string): Promise<RetryClaimResult> {
    return this.run(intentId);
  }
  claim(
    intentId: string,
    policy: RecoveryPolicySnapshot,
  ): Promise<RetryClaimResult> {
    return this.run(intentId, policy);
  }

  private async run(
    intentId: string,
    policy?: RecoveryPolicySnapshot,
  ): Promise<RetryClaimResult> {
    const operation = policy ? "claim" : "inspect";
    this.serviceLogger.debug("recovery.delivery_retry.evaluation_started", {
      retryIntentId: intentId,
      operation,
    });
    for (let n = 1; n <= 3; n++) {
      const context: ClaimLogContext = {
        stage: "identity",
        fields: { retryIntentId: intentId, operation },
        timing: new RecoveryTransactionTiming(),
      };
      try {
        const result = await this.database.$transaction(
          (tx) =>
            context.timing.measure(() =>
              this.evaluate(tx, intentId, context, policy),
            ),
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          },
        );
        // Never report a durable claim until the transaction has committed.
        const fields = {
          ...context.fields,
          stage: context.stage,
          outcome: result.kind,
          transactionAttempt: n,
          ...context.timing.snapshot(),
        };
        if (result.kind === "held") {
          this.serviceLogger.debug("recovery.delivery_retry.eligibility_held", {
            ...fields,
            reason: result.reason,
          });
        } else if (result.kind === "claimed") {
          this.serviceLogger.info("recovery.delivery_retry.claimed", fields);
        } else {
          this.serviceLogger.debug(
            result.kind === "existing"
              ? "recovery.delivery_retry.claim_replayed"
              : "recovery.delivery_retry.eligible",
            fields,
          );
        }
        return result;
      } catch (error) {
        const sourceError = initialOutreachDiagnostic(error);
        const fields = {
          ...context.fields,
          stage: context.stage,
          transactionAttempt: n,
          errorMessage: sourceError.message,
          sourceError,
          ...context.timing.snapshot(),
          ...transactionFailureDetails(error),
          ...(error instanceof Prisma.PrismaClientKnownRequestError
            ? { prismaCode: error.code }
            : {}),
        };
        if (error instanceof RecoveryCompensationLineageError) {
          this.serviceLogger.debug("recovery.delivery_retry.claim_held", {
            ...fields,
            reason: "policy-or-funding-lineage",
          });
          return held("policy-or-funding-lineage");
        }
        const replayable = isReplayableRecoveryTransactionError(error);
        if (replayable && n < 3) {
          const retryBackoffMs = recoveryTransactionBackoffMs(n, error);
          this.serviceLogger.warn("recovery.delivery_retry.claim_conflict", {
            ...fields,
            retryBackoffMs,
          });
          await waitForRecoveryTransactionReplay(retryBackoffMs);
          continue;
        }
        this.serviceLogger.error("recovery.delivery_retry.claim_failed", {
          ...fields,
          retryExhausted: replayable,
        });
        throw error;
      }
    }
    throw new Error("Unreachable retry claim state");
  }

  private async evaluate(
    tx: Tx,
    intentId: string,
    context: ClaimLogContext,
    policy?: RecoveryPolicySnapshot,
  ): Promise<RetryClaimResult> {
    const pointer = await tx.recoveryOutreachRetryIntent.findUnique({
      where: { id: intentId },
      select: {
        failedAttemptId: true,
        failedMessageId: true,
        fundingReservationId: true,
        providerFailureCode: true,
        policy: true,
        notBeforeAt: true,
        cancelledAt: true,
        failedAttempt: {
          select: {
            checkoutRecovery: {
              select: {
                id: true,
                shopId: true,
                conversation: { select: { id: true } },
              },
            },
          },
        },
      },
    });
    const recoveryPointer = pointer?.failedAttempt.checkoutRecovery;
    if (pointer)
      Object.assign(context.fields, {
        failedAttemptId: pointer.failedAttemptId,
        failedMessageId: pointer.failedMessageId,
        predecessorReservationId: pointer.fundingReservationId,
        providerFailureCode: pointer.providerFailureCode,
        policy: pointer.policy,
        notBeforeAt: pointer.notBeforeAt?.toISOString(),
        cancelledAt: pointer.cancelledAt?.toISOString(),
        shopId: recoveryPointer?.shopId,
        checkoutRecoveryId: recoveryPointer?.id,
        conversationId: recoveryPointer?.conversation?.id,
      });
    if (!recoveryPointer?.conversation) return held("missing-owner");
    context.stage = "owner_lock";
    context.timing.enter(context.stage);
    const conversationId = recoveryPointer.conversation.id;
    const owner = await lockRecoveryContext(tx, conversationId, {
      shopId: recoveryPointer.shopId,
      recoveryId: recoveryPointer.id,
      contention: "nowait",
    });
    if (
      !owner ||
      owner.recoveryId !== recoveryPointer.id ||
      owner.shopId !== recoveryPointer.shopId
    )
      return held("owner-changed");
    const now = this.clock();
    context.fields.evaluationAt = now.toISOString();
    context.stage = "recovery_eligibility";
    context.timing.enter(context.stage);
    const recovery = await tx.checkoutRecovery.findUniqueOrThrow({
      where: { id: owner.recoveryId },
      select: {
        id: true,
        shopId: true,
        checkoutToken: true,
        generation: true,
        status: true,
        lastExternalActivityAt: true,
        completedAt: true,
        expiredAt: true,
        admissionBlockReason: true,
        shop: { select: { status: true } },
      },
    });
    const config = await tx.backgroundRuntimeConfig.findUnique({
      where: { id: "default" },
      select: { checkoutRecoveryLifetimeDays: true },
    });
    // Keep the existing public hold result; expose the actual failing gate in logs.
    const detail =
      recovery.shop.status !== "ACTIVE"
        ? "shop-inactive"
        : !["DETECTED", "MESSAGE_SENT"].includes(recovery.status) ||
            recovery.completedAt ||
            recovery.expiredAt
          ? "recovery-closed"
          : recovery.admissionBlockReason === "WHATSAPP_RECIPIENT_SUPPRESSED"
            ? "recipient-suppressed"
            : owner.mode !== "AI"
              ? "human-control"
              : owner.inboundVersion !== 0 || owner.lastInboundAt
                ? "customer-responded"
                : !config
                  ? "runtime-config-missing"
                  : !isCheckoutRecoveryWithinLifetime({
                        lastExternalActivityAt: recovery.lastExternalActivityAt,
                        now,
                        checkoutRecoveryLifetimeDays:
                          config.checkoutRecoveryLifetimeDays,
                      })
                    ? "checkout-lifetime-expired"
                    : null;
    if (detail) {
      context.fields.holdDetail = detail;
      return held("recovery-ineligible");
    }
    if (
      await tx.checkoutRecovery.findFirst({
        where: {
          shopId: recovery.shopId,
          checkoutToken: recovery.checkoutToken,
          generation: { gt: recovery.generation },
        },
        select: { id: true },
      })
    )
      return held("newer-generation");
    if (
      await tx.conversationAllowanceBlock.count({ where: { conversationId } })
    )
      return held("existing-allowance");
    context.stage = "attempt_lineage";
    context.timing.enter(context.stage);
    const attempts = await tx.recoveryOutreachAttempt.findMany({
      where: { checkoutRecoveryId: owner.recoveryId },
      select: retryFundingIdentitySelect,
    });
    const plan = planInitialRetryClaim({
      intentId,
      recoveryId: owner.recoveryId,
      conversationId,
      attempts,
    });
    if (plan.kind === "held") return plan;
    Object.assign(context.fields, {
      outreachAttemptId: plan.attemptId,
      sequence: plan.sequence,
      retryOrdinal: plan.links.length,
    });
    if (plan.kind === "existing") {
      const existing = await tx.recoveryOutreachAttempt.findUniqueOrThrow({
        where: { id: plan.attemptId },
        select: {
          closedAt: true,
          followUpDueAt: true,
          initiationKey: true,
          claimedAt: true,
          initiatedBy: true,
        },
      });
      if (
        existing.closedAt ||
        existing.followUpDueAt ||
        existing.initiationKey ||
        existing.claimedAt ||
        existing.initiatedBy
      ) {
        return held("claim-not-clean");
      }
    }
    context.stage = "predecessor_funding_and_policy";
    context.timing.enter(context.stage);
    await requireInitialRetryPredecessorReady(
      tx,
      {
        shopId: owner.shopId,
        recoveryId: owner.recoveryId,
        conversationId,
        now,
      },
      plan.links,
    );
    // Never allocate or switch sender as a workaround for a rejected message.
    context.stage = "sender_assignment";
    context.timing.enter(context.stage);
    const sender = await tx.recoverySenderAssignment.findUnique({
      where: { conversationId },
      select: {
        releasedAt: true,
        route: {
          select: {
            closedAt: true,
            shopId: true,
            canonicalRecipient: true,
            providerPhoneNumberId: true,
            thread: {
              select: {
                closedAt: true,
                sender: {
                  select: { providerAccountId: true, verifiedAt: true },
                },
              },
            },
          },
        },
      },
    });
    const route = sender?.route;
    if (
      !sender ||
      sender.releasedAt ||
      !route ||
      route.closedAt ||
      route.thread.closedAt ||
      route.shopId !== owner.shopId ||
      route.canonicalRecipient !== plan.recipient.replace(/^\+/, "") ||
      route.thread.sender.verifiedAt > now
    )
      return held("sender-assignment-unavailable");
    const failed = await tx.conversationMessage.findUniqueOrThrow({
      where: { id: plan.links.at(-1)!.intent.failedMessageId },
      select: {
        dispatchProviderAccountId: true,
        dispatchProviderPhoneNumberId: true,
      },
    });
    if (
      failed.dispatchProviderAccountId !==
        route.thread.sender.providerAccountId ||
      failed.dispatchProviderPhoneNumberId !== route.providerPhoneNumberId
    )
      return held("sender-identity-changed");
    context.fields.providerAccountId = route.thread.sender.providerAccountId;
    context.stage = "outbound_progress";
    context.timing.enter(context.stage);
    // An existing prepared/admitted message is not a claim to send again.
    if (
      await tx.usageEvent.findUnique({
        where: { idempotencyKey: `recovery-outreach:${plan.attemptId}` },
        select: { id: true },
      })
    )
      return held("outbound-progress-exists");
    const identity = {
      attemptId: plan.attemptId,
      sequence: plan.sequence,
      recoveryId: owner.recoveryId,
      conversationId,
    };
    if (plan.kind === "existing") return { kind: "existing", ...identity };
    if (!policy) return { kind: "ready", ...identity };
    context.stage = "attempt_create";
    context.timing.enter(context.stage);
    await tx.recoveryOutreachAttempt.create({
      data: {
        id: plan.attemptId,
        checkoutRecoveryId: owner.recoveryId,
        sequence: plan.sequence,
        trigger: "INITIAL",
        recipient: plan.recipient,
        status: "PENDING",
        configuredOfferMode: policy.recoveryOfferMode,
        fixedShopifyDiscountId: policy.fixedShopifyDiscountId,
        offerSnapshot: policy.offerSnapshot
          ? (policy.offerSnapshot as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });
    return { kind: "claimed", ...identity };
  }
}
