import { Prisma, type PrismaClient } from "@prisma/client";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { retryOutreachAttemptId } from "../../domain/recovery-outreach-identity.js";
import { followUpRetryBlockId } from "../../domain/recovery-follow-up-retry-allowance.js";
import { lockRecoveryContext } from "../recovery-conversation/recovery-conversation.sql.js";
import { CUSTOMER_WINDOW_MS } from "../recovery-conversation/recovery-follow-up-policy.service.js";
import {
  scheduledFollowUpRetryOwnerDenial,
  readScheduledFollowUpRetrySender,
  scheduledFollowUpRetryClaimKey,
  type ScheduledFollowUpRetryScope,
} from "./follow-up-eligibility.js";
import {
  RecoveryCompensationLineageError,
  requireLineage,
} from "../recovery-delivery-compensation/types.js";
import {
  ExistingHoldSignal,
  readReservedRecoveryFunding,
} from "../recovery-billing/reserved-recovery-funding.js";
import { admitRetryCapacityInTransaction } from "../recovery-billing/capacity-policy.js";
import type { RecoveryBillingAdmission } from "../recovery-billing/recovery-billing.types.js";
import { inspectScheduledFollowUpRetryLineage } from "./follow-up-lineage.js";
import { serializeRetryFunding } from "./funding-admission-gate.js";
import { initialOutreachDiagnostic } from "./error-diagnostic.js";
import {
  RecoveryTransactionTiming,
  isReplayableRecoveryTransactionError,
  recoveryTransactionBackoffMs,
  transactionFailureDetails,
  waitForRecoveryTransactionReplay,
} from "./transaction-resilience.js";

const logger = createLogger({
  serviceName: "moda-recovery-worker",
  environment: resolveDeploymentEnvironmentName(),
});
type Tx = Prisma.TransactionClient;
type Scope = ScheduledFollowUpRetryScope;
type Result =
  | { kind: "held"; reason: string }
  | {
      kind: "funded" | "existing";
      attemptId: string;
      sequence: number;
      blockId: string;
      reservationId: string;
      admission: RecoveryBillingAdmission;
    };
const held = (reason: string): Result => ({ kind: "held", reason });

/** SQL-only claim + fresh reservation + allowance pin.
 * Execution must hold the platform checkout lease, perform current
 * stored-consent, order, recipient and template preflight BEFORE invoking this
 * owner, then obtain the separate final provider permit. Nothing here sends,
 * commits a credit or marks a message accepted. A lost transaction ACK can
 * replay only the exact clean attempt/reservation/block tuple. */
export class ScheduledFollowUpRetryFundingService {
  constructor(
    private readonly db: Pick<PrismaClient, "$transaction">,
    private readonly clock: () => Date = () => new Date(),
    private readonly log: StructuredLogger = logger,
  ) {}

  async claimAndFund(scope: Scope): Promise<Result> {
    if (
      !scope.shopId ||
      !scope.recoveryId ||
      !scope.conversationId ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(scope.intentId)
    )
      return held("invalid-retry-scope");
    return serializeRetryFunding(scope.shopId, async (queueWaitMs) => {
      for (let n = 1; n <= 3; n++) {
        const timing = new RecoveryTransactionTiming();
        const fields = {
          shopId: scope.shopId,
          checkoutRecoveryId: scope.recoveryId,
          conversationId: scope.conversationId,
          retryIntentId: scope.intentId,
          outreachAttemptId: retryOutreachAttemptId(scope.intentId),
          transactionAttempt: n,
          queueWaitMs,
        };
        try {
          const result = await this.db.$transaction(
            (tx) => timing.measure(() => this.fund(tx, scope, timing)),
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          );
          if (result.kind === "held")
            this.log.debug("recovery.delivery_retry.follow_up_funding_held", {
              ...fields,
              reason: result.reason,
              ...timing.snapshot(),
            });
          else if (result.kind === "funded")
            this.log.info("recovery.delivery_retry.follow_up_funded", {
              ...fields,
              sequence: result.sequence,
              allowanceBlockId: result.blockId,
              fundingReservationId: result.reservationId,
              ...timing.snapshot(),
            });
          else
            this.log.debug(
              "recovery.delivery_retry.follow_up_funding_replayed",
              {
                ...fields,
                allowanceBlockId: result.blockId,
                fundingReservationId: result.reservationId,
                ...timing.snapshot(),
              },
            );
          return result;
        } catch (error) {
          const evidence = {
            ...fields,
            ...timing.snapshot(),
            ...transactionFailureDetails(error),
            sourceError: initialOutreachDiagnostic(
              error instanceof ExistingHoldSignal && error.original
                ? error.original
                : error,
            ),
          };
          if (
            error instanceof RecoveryCompensationLineageError ||
            error instanceof ExistingHoldSignal
          ) {
            this.log.debug("recovery.delivery_retry.follow_up_funding_held", {
              ...evidence,
              reason:
                error instanceof ExistingHoldSignal
                  ? error.reason
                  : "policy-or-funding-lineage",
            });
            return held(
              error instanceof ExistingHoldSignal
                ? error.reason
                : "policy-or-funding-lineage",
            );
          }
          const replayable = isReplayableRecoveryTransactionError(error);
          if (replayable && n < 3) {
            const retryBackoffMs = recoveryTransactionBackoffMs(n, error);
            this.log.warn(
              "recovery.delivery_retry.follow_up_funding_conflict",
              { ...evidence, retryBackoffMs },
            );
            await waitForRecoveryTransactionReplay(retryBackoffMs);
            continue;
          }
          this.log.error("recovery.delivery_retry.follow_up_funding_failed", {
            ...evidence,
            retryExhausted: replayable,
          });
          throw error;
        }
      }
      throw new Error("Unreachable follow-up retry funding state");
    });
  }

  private async fund(
    tx: Tx,
    scope: Scope,
    timing: RecoveryTransactionTiming,
  ): Promise<Result> {
    timing.enter("owner_lock");
    const owner = await lockRecoveryContext(tx, scope.conversationId, {
      shopId: scope.shopId,
      recoveryId: scope.recoveryId,
      contention: "nowait",
    });
    if (
      !owner ||
      owner.mode !== "AI" ||
      owner.lastInboundAt ||
      owner.inboundVersion !== 0
    )
      return held("owner-ineligible");
    const locked = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM commerce."CheckoutRecovery" WHERE id=${scope.recoveryId} FOR UPDATE NOWAIT`;
    if (locked.length !== 1) return held("recovery-unavailable");
    const now = this.clock();
    timing.enter("recovery_eligibility");
    const denial = await scheduledFollowUpRetryOwnerDenial(
      tx,
      scope,
      owner,
      now,
    );
    if (denial) return held(denial);

    const attemptId = retryOutreachAttemptId(scope.intentId);
    const creditScope = {
      ...scope,
      outreachAttemptId: attemptId,
      outboundMessageId: null,
    };
    const setStage = (value: string) => timing.enter(value);
    const retained = await readReservedRecoveryFunding(
      tx,
      creditScope,
      true,
      now,
      setStage,
    );
    if (retained.kind === "held") return held(`credit:${retained.reason}`);
    timing.enter("historical_lineage");
    const inspected = await inspectScheduledFollowUpRetryLineage(tx, {
      ...scope,
      now,
      ...(retained.kind === "admitted"
        ? { fundedReservationId: retained.reservationId }
        : {}),
    });
    if (inspected.kind === "held") return held(inspected.reason);
    const { plan, allowance } = inspected;
    if (
      plan.attemptId !== attemptId ||
      (plan.kind === "existing") !== (retained.kind === "admitted")
    )
      return held("incomplete-claim-funding-tuple");
    timing.enter("claim_identity");
    const history = await tx.recoveryOutreachAttempt.findMany({
      where: { id: { in: plan.links.map((link) => link.predecessor.id) } },
    });
    const historicalAttempts = new Map(
      history.map((attempt) => [attempt.id, attempt]),
    );
    const predecessor = historicalAttempts.get(
      plan.links.at(-1)!.predecessor.id,
    );
    if (
      !predecessor ||
      plan.links.some((link, index) => {
        const attempt = historicalAttempts.get(link.predecessor.id);
        const key =
          index === 0
            ? `scheduled-no-response:${scope.recoveryId}`
            : scheduledFollowUpRetryClaimKey(plan.links[index - 1]!.intent.id);
        return !attempt?.claimedAt || attempt.initiationKey !== key;
      })
    )
      return held("scheduled-claim-identity");
    if (plan.kind === "existing") {
      const attempt = await tx.recoveryOutreachAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      });
      if (
        attempt.status !== "PENDING" ||
        attempt.initiationKey !==
          scheduledFollowUpRetryClaimKey(scope.intentId) ||
        !attempt.claimedAt ||
        attempt.closedAt ||
        attempt.failureCode ||
        attempt.followUpDueAt
      )
        return held("claim-not-clean");
    }
    if (
      await tx.usageEvent.findUnique({
        where: { idempotencyKey: `recovery-outreach:${attemptId}` },
        select: { id: true },
      })
    )
      return held("outbound-progress-exists");
    timing.enter("sender_assignment");
    if (
      !(await readScheduledFollowUpRetrySender(
        tx,
        scope,
        plan.recipient,
        plan.links.map((l) => l.intent.failedMessageId),
        now,
      ))
    )
      return held("sender-identity-changed");
    if (retained.kind === "admitted") {
      requireLineage(
        inspected.fundedBlockId,
        "follow-up retry funded block missing",
      );
      return {
        kind: "existing",
        attemptId,
        sequence: plan.sequence,
        blockId: inspected.fundedBlockId,
        reservationId: retained.reservationId,
        admission: retained.admission,
      };
    }

    timing.enter("reserve_retry");
    const logical = createRecoveryIdempotencyKey(
      scope.shopId,
      `recovery-outreach:${attemptId}`,
    );
    const outcome = await admitRetryCapacityInTransaction(
      tx,
      creditScope,
      logical,
    );
    if (outcome.result.kind === "blocked")
      return held(`credit:${outcome.result.reason}`);
    const checked = await readReservedRecoveryFunding(
      tx,
      creditScope,
      true,
      now,
      setStage,
    );
    requireLineage(
      checked.kind === "admitted" &&
        checked.admission.sourceKey === outcome.result.admission.sourceKey,
      "follow-up retry reservation not proven",
    );
    const limits = checked.admission.policy;
    requireLineage(
      Number.isSafeInteger(limits.outboundHardLimit) &&
        Number.isSafeInteger(limits.terminalMessageReservedSlots) &&
        limits.terminalMessageReservedSlots >= 0 &&
        limits.outboundHardLimit > limits.terminalMessageReservedSlots,
      "follow-up retry allowance has no normal capacity",
    );
    timing.enter("claim_and_bind");
    // Both records and the credit commit atomically. No unbound FOLLOW_UP
    // block exists for the legacy sequence-two repair lookup to misidentify.
    await tx.recoveryOutreachAttempt.create({
      data: {
        id: attemptId,
        checkoutRecoveryId: scope.recoveryId,
        sequence: plan.sequence,
        trigger: "NO_RESPONSE_FOLLOW_UP",
        status: "PENDING",
        recipient: plan.recipient,
        initiatedBy: "AUTOMATION",
        initiationKey: scheduledFollowUpRetryClaimKey(scope.intentId),
        claimedAt: now,
        configuredOfferMode: predecessor.configuredOfferMode,
        fixedShopifyDiscountId: predecessor.fixedShopifyDiscountId,
        offerSnapshot:
          predecessor.offerSnapshot === null
            ? Prisma.JsonNull
            : (predecessor.offerSnapshot as Prisma.InputJsonValue),
      },
    });
    const previous = await tx.conversationAllowanceBlock.findUniqueOrThrow({
      where: { id: allowance.failedBlockId },
      select: { ordinal: true },
    });
    const block = await tx.conversationAllowanceBlock.create({
      data: {
        id: followUpRetryBlockId(attemptId),
        shopId: scope.shopId,
        conversationId: scope.conversationId,
        ordinal: previous.ordinal + 1,
        fundingKind: "FOLLOW_UP",
        state: "PENDING",
        predecessorId: allowance.initialBlockId,
        creditReservationId: checked.reservationId,
        hardMessageLimit: limits.outboundHardLimit,
        terminalReservedSlots: limits.terminalMessageReservedSlots,
        repairAt: now,
        repairDeadlineAt: new Date(now.getTime() + CUSTOMER_WINDOW_MS),
      },
    });
    return {
      kind: "funded",
      attemptId,
      sequence: plan.sequence,
      blockId: block.id,
      reservationId: checked.reservationId,
      admission: checked.admission,
    };
  }
}
