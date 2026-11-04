import {
  BillingPeriodStatus,
  Prisma,
  UsageReservationStatus,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import {
  createLogger,
  type StructuredLogger,
} from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../../runtime/deployment-environment.js";
import { EffectiveBillingPolicyResolver, EffectiveBillingPolicyError } from "../effective-billing-policy.service.js";
import { PostContractRecoveryPolicyResolver, PostContractRecoveryPolicyError } from "../post-contract-recovery-policy.service.js";
import { freeRecoveryReservationService } from "../free-recovery-reservation.service.js";
import { paidIncludedRecoveryReservationService, PaidIncludedRecoveryReservationError } from "../paid-included-recovery-reservation.service.js";
import { promotionalRecoveryReservationService } from "../promotional-recovery-reservation.service.js";
import { purchasedRecoveryReservationService } from "../purchased-recovery-reservation.service.js";
import { findExactRecoveryReservationSource } from "../recovery-delivery-compensation/lineage.js";
import { readCommittedRecoveryUsage } from "../recovery-delivery-compensation/committed-usage.js";
import { RecoveryCompensationLineageError } from "../recovery-delivery-compensation/types.js";
import { DEFAULT_RECOVERY_RESERVATION_TRANSACTION_RETRIES, isRecoveryReservationRetryableConflict } from "../recovery-reservation/reservation-lifecycle.js";
import type { ExistingInitialOutreachCredit, ExistingInitialOutreachCreditInput, ConfirmedInitialOutreachCreditInput, ConfirmedInitialOutreachSettlement, RecoveryBillingAdmission } from "./recovery-billing.types.js";
import { assertNoInitialMessageEvidence, readInitialAttempt, readInitialMessage, validateInitialMessageIdentity } from "./initial-outreach-credit-evidence.js";

const logger = createLogger({ serviceName: "moda-recovery-worker", environment: resolveDeploymentEnvironmentName() });
type Database = Pick<PrismaClient, "$transaction">;
type Tx = Prisma.TransactionClient;
type HoldReason = Extract<ConfirmedInitialOutreachSettlement, { kind: "held" }>["reason"];
type ExistingHoldReason = Extract<ExistingInitialOutreachCredit, { kind: "held" }>["reason"];
class HoldSignal extends Error {
  constructor(readonly reason: HoldReason, readonly source?: { reservationId: string; sourceKey: string }, readonly original?: unknown) { super(reason); }
}
class ExistingHoldSignal extends Error {
  constructor(readonly reason: ExistingHoldReason, readonly source?: { reservationId: string; sourceKey: string }, readonly original?: unknown) { super(reason); }
}

export class InitialOutreachCreditService {
  constructor(private readonly database: Database, private readonly serviceLogger: StructuredLogger = logger, private readonly maxAttempts = DEFAULT_RECOVERY_RESERVATION_TRANSACTION_RETRIES) {}

  async settleConfirmedInitialOutreach(input: ConfirmedInitialOutreachCreditInput): Promise<ConfirmedInitialOutreachSettlement> {
    let stage: string;
    let sourceKind: string | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      stage = "identity";
      sourceKind = undefined;
      try {
        const result = await this.database.$transaction(async (tx) => {
          const attemptEvidence = await readInitialAttempt(tx, input);
          const pointer = await readInitialMessage(tx, input.outboundMessageId);
          if (!pointer) throw new HoldSignal("message-not-confirmed");
          if (pointer.conversation.checkoutRecovery?.shopId !== input.shopId) throw new HoldSignal("lineage-conflict");
          const shops = await tx.$queryRaw<Array<{ id: string; platform: string }>>`SELECT "id", "platform" FROM "commerce"."Shop" WHERE "id"=${input.shopId} FOR KEY SHARE`;
          if (shops.length !== 1) throw new HoldSignal("lineage-conflict");
          await tx.$queryRaw`SELECT "id" FROM "whatsapp"."ConversationMessage" WHERE "id"=${input.outboundMessageId} FOR UPDATE`;
          const message = await readInitialMessage(tx, input.outboundMessageId);
          if (!message || message.id !== pointer.id || message.providerMessageId !== pointer.providerMessageId || message.conversationId !== pointer.conversationId || message.conversation.shopId !== pointer.conversation.shopId || message.conversation.checkoutRecovery?.id !== input.recoveryId || message.conversation.checkoutRecovery.shopId !== input.shopId) throw new HoldSignal("lineage-conflict");
          const usage = await validateInitialMessageIdentity(tx, input, attemptEvidence, message, false);
          if (!(message.status === "SENT" || message.status === "DELIVERED" || message.status === "READ") || !message.sentAt || message.providerFailureCode || message.failedAt) throw new HoldSignal("message-not-confirmed");
          stage = "source_lookup";
          const source = await findExactRecoveryReservationSource(tx, input.shopId, input.outreachAttemptId);
          if (!source) throw new HoldSignal("lineage-conflict");
          const { reservation, kind } = source;
          sourceKind = kind;
          const sourceInfo = { reservationId: reservation.id, sourceKey: reservation.sourceKey };
          if (reservation.quantity !== 1) throw new HoldSignal("lineage-conflict", sourceInfo);
          if (reservation.compensationUsageEventId || reservation.compensationReason || reservation.compensationDisposition || reservation.compensatedAt) throw new HoldSignal("reservation-compensated", sourceInfo);
          if (reservation.committedUsageEventId && await tx.usageEvent.count({ where: { correctionOfUsageEventId: reservation.committedUsageEventId } }) > 0) throw new HoldSignal("reservation-compensated", sourceInfo);
          if (reservation.status === UsageReservationStatus.AMBIGUOUS) throw new HoldSignal("reservation-ambiguous", sourceInfo);
          if (reservation.status === UsageReservationStatus.RELEASED) throw new HoldSignal("reservation-released", sourceInfo);
          if (reservation.status !== UsageReservationStatus.RESERVED && reservation.status !== UsageReservationStatus.COMMITTED) throw new HoldSignal("lineage-conflict", sourceInfo);
          if (reservation.status === UsageReservationStatus.RESERVED) {
            stage = "source_commit";
            try {
              const outcome = await commitSource(tx, source, input.shopId, message.sentAt);
              if (!isPositiveOwnerOutcome(outcome, input.shopId, reservation.sourceKey)) throw new HoldSignal("settlement-not-committed", sourceInfo);
            } catch (error) {
              if (error instanceof PaidIncludedRecoveryReservationError && error.reason === "PERIOD_NOT_CURRENT_OPEN") throw new HoldSignal("paid-period-not-current", sourceInfo, error);
              throw error;
            }
          }
          stage = "committed_usage_verification";
          const committedSource = await findExactRecoveryReservationSource(tx, input.shopId, input.outreachAttemptId);
          if (!committedSource || committedSource.reservation.id !== reservation.id || committedSource.reservation.status !== UsageReservationStatus.COMMITTED) throw new HoldSignal("settlement-not-committed", sourceInfo);
          const committedUsage = await readCommittedRecoveryUsage(tx, committedSource);
          if (committedUsage.provider !== shops[0]!.platform || !committedUsage.quantity.equals(1) || (kind === "paid" && committedUsage.billingPeriodId !== await paidPeriodId(tx, reservation))) throw new HoldSignal("lineage-conflict", sourceInfo);
          if (usage && (usage.sourceType !== "OUTBOUND_AUTOMATED_MESSAGE" || usage.idempotencyKey !== `recovery-outreach:${input.outreachAttemptId}`)) throw new HoldSignal("lineage-conflict", sourceInfo);
          return { kind: "settled", disposition: reservation.status === UsageReservationStatus.COMMITTED ? "already-committed" : "committed", sourceKind: kind, sourceKey: reservation.sourceKey, reservationId: reservation.id, committedUsageEventId: committedUsage.id, outboundMessageId: message.id, sentAt: message.sentAt } as const;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        return result;
      } catch (error) {
        if (error instanceof HoldSignal) {
          this.serviceLogger.warn("recovery.initial_outreach_credit.held", { operation: "settleConfirmedInitialOutreach", stage, ...input, ...(error.source ?? {}), ...(sourceKind ? { sourceKind } : {}), reason: error.reason, ...(error.original ? { error: error.original, ...errorCauseContext(error.original), ...databaseErrorContext(error.original) } : {}) });
          return { kind: "held", reason: error.reason, ...(error.source ? { reservationId: error.source.reservationId, sourceKey: error.source.sourceKey } : {}) };
        }
        if (error instanceof RecoveryCompensationLineageError) {
          this.serviceLogger.warn("recovery.initial_outreach_credit.held", { operation: "settleConfirmedInitialOutreach", stage, ...input, reason: "lineage-conflict", error, ...errorCauseContext(error), ...databaseErrorContext(error) });
          return { kind: "held", reason: "lineage-conflict" };
        }
        if (isRecoveryReservationRetryableConflict(error) && attempt < this.maxAttempts) {
          this.serviceLogger.warn("recovery.initial_outreach_credit.retry", { operation: "settleConfirmedInitialOutreach", stage, ...input, ...(sourceKind ? { sourceKind } : {}), attempt, maxAttempts: this.maxAttempts, reasonCode: conflictCode(error), error, ...errorCauseContext(error), ...databaseErrorContext(error) });
          continue;
        }
        this.serviceLogger.error("recovery.initial_outreach_credit.failed", { operation: "settleConfirmedInitialOutreach", stage, ...input, ...(sourceKind ? { sourceKind } : {}), attempt, maxAttempts: this.maxAttempts, retryExhausted: isRecoveryReservationRetryableConflict(error), error, ...errorCauseContext(error), ...databaseErrorContext(error) });
        throw error;
      }
    }
    throw new Error("Unreachable settlement retry state");
  }

  async revalidateExistingInitialOutreach(input: ExistingInitialOutreachCreditInput): Promise<ExistingInitialOutreachCredit> {
    let stage: string;
    let sourceKind: string | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      stage = "identity";
      sourceKind = undefined;
      try {
        const result = await this.database.$transaction((tx) => revalidate(tx, input, this.now(), (value, kind) => { stage = value; if (kind) sourceKind = kind; }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        if (result.kind === "held") this.serviceLogger.warn("recovery.initial_outreach_credit.held", { operation: "revalidateExistingInitialOutreach", stage, ...input, ...(result.reservationId ? { reservationId: result.reservationId } : {}), ...(result.sourceKey ? { sourceKey: result.sourceKey } : {}), ...(sourceKind ? { sourceKind } : {}), reason: result.reason });
        return result;
      } catch (error) {
        if (error instanceof ExistingHoldSignal) {
          this.serviceLogger.warn("recovery.initial_outreach_credit.held", { operation: "revalidateExistingInitialOutreach", stage, ...input, ...(error.source ?? {}), ...(sourceKind ? { sourceKind } : {}), reason: error.reason, ...(error.original ? { error: error.original, ...errorCauseContext(error.original), ...databaseErrorContext(error.original) } : {}) });
          return { kind: "held", reason: error.reason, ...(error.source ? { reservationId: error.source.reservationId, sourceKey: error.source.sourceKey } : {}) };
        }
        if (error instanceof RecoveryCompensationLineageError) {
          this.serviceLogger.warn("recovery.initial_outreach_credit.held", { operation: "revalidateExistingInitialOutreach", stage, ...input, reason: "lineage-conflict", error, ...errorCauseContext(error), ...databaseErrorContext(error) });
          return { kind: "held", reason: "lineage-conflict" };
        }
        if (isRecoveryReservationRetryableConflict(error) && attempt < this.maxAttempts) {
          this.serviceLogger.warn("recovery.initial_outreach_credit.retry", { operation: "revalidateExistingInitialOutreach", stage, ...input, ...(sourceKind ? { sourceKind } : {}), attempt, maxAttempts: this.maxAttempts, reasonCode: conflictCode(error), error, ...errorCauseContext(error), ...databaseErrorContext(error) });
          continue;
        }
        this.serviceLogger.error("recovery.initial_outreach_credit.failed", { operation: "revalidateExistingInitialOutreach", stage, ...input, ...(sourceKind ? { sourceKind } : {}), attempt, maxAttempts: this.maxAttempts, retryExhausted: isRecoveryReservationRetryableConflict(error), error, ...errorCauseContext(error), ...databaseErrorContext(error) });
        throw error;
      }
    }
    throw new Error("Unreachable revalidation retry state");
  }

  private readonly now = () => new Date();
}

async function commitSource(tx: Tx, source: NonNullable<Awaited<ReturnType<typeof findExactRecoveryReservationSource>>>, shopId: string, sentAt: Date) {
  const { reservation, kind } = source;
  if (kind === "free") return freeRecoveryReservationService.commitInExistingTransaction(tx, { shopId, sourceKey: reservation.sourceKey });
  if (kind === "purchased") return purchasedRecoveryReservationService.commitInExistingTransaction(tx, { shopId, sourceKey: reservation.sourceKey });
  if (kind === "promotional") return promotionalRecoveryReservationService.commitInExistingTransaction(tx, { shopId, sourceKey: reservation.sourceKey });
  return paidIncludedRecoveryReservationService.commitInExistingTransaction(tx, { shopId, sourceKey: reservation.sourceKey, occurredAt: sentAt });
}

function isPositiveOwnerOutcome(outcome: { kind: string; reservation?: { shopId: string; sourceKey: string; status: string; quantity: number; committedUsageEventId: string | null } }, shopId: string, sourceKey: string): boolean {
  return (outcome.kind === "committed" || outcome.kind === "already-committed") && outcome.reservation?.shopId === shopId && outcome.reservation.sourceKey === sourceKey && outcome.reservation.status === "COMMITTED" && outcome.reservation.quantity === 1 && !!outcome.reservation.committedUsageEventId;
}

async function paidPeriodId(tx: Tx, reservation: { billingPeriodEntitlementCounterId: string | null }): Promise<string | null> {
  if (!reservation.billingPeriodEntitlementCounterId) return null;
  return (await tx.billingPeriodEntitlementCounter.findUnique({ where: { id: reservation.billingPeriodEntitlementCounterId }, select: { billingPeriodId: true } }))?.billingPeriodId ?? null;
}

function conflictCode(error: unknown): string {
  return error instanceof Prisma.PrismaClientKnownRequestError ? error.code : "internal-concurrency-conflict";
}

function errorCauseContext(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object" || !("cause" in error)) return {};
  return { cause: (error as { cause?: unknown }).cause };
}

function databaseErrorContext(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return {};
  const record = error as { code?: unknown; clientVersion?: unknown; meta?: unknown };
  const isPrismaError = error instanceof Prisma.PrismaClientKnownRequestError;
  const suppliedSqlState = !!record.meta && typeof record.meta === "object" &&
    typeof (record.meta as Record<string, unknown>).code === "string" &&
    /^[A-Za-z0-9]{5}$/.test((record.meta as Record<string, unknown>).code as string);
  if (!isPrismaError && !suppliedSqlState) return {};
  const databaseError: Record<string, unknown> = {};
  if (isPrismaError && typeof record.code === "string" && record.code.length <= 32) databaseError.code = record.code;
  if (isPrismaError && typeof record.clientVersion === "string" && record.clientVersion.length <= 64) databaseError.clientVersion = record.clientVersion;
  if (record.meta && typeof record.meta === "object" && !Array.isArray(record.meta)) {
    const meta = record.meta as Record<string, unknown>;
    const safeMeta: Record<string, unknown> = {};
    for (const key of ["modelName", "target", "constraint", "field_name"] as const) {
      const value = meta[key];
      if (typeof value === "string" && /^[A-Za-z0-9_.$:-]{1,128}$/.test(value)) safeMeta[key] = value;
      else if (Array.isArray(value) && value.length <= 16 && value.every((part) => typeof part === "string" && /^[A-Za-z0-9_.$:-]{1,128}$/.test(part))) safeMeta[key] = value;
    }
    if (typeof meta.code === "string" && /^[A-Za-z0-9]{5}$/.test(meta.code)) safeMeta.code = meta.code;
    if (Object.keys(safeMeta).length) databaseError.meta = safeMeta;
  }
  return Object.keys(databaseError).length ? { databaseError } : {};
}

async function revalidate(tx: Tx, input: ExistingInitialOutreachCreditInput, now: Date, setStage: (stage: string, sourceKind?: string) => void): Promise<ExistingInitialOutreachCredit> {
  setStage("identity");
  const attempt = await readInitialAttempt(tx, input);
  if (input.outboundMessageId === null) await assertNoInitialMessageEvidence(tx, input, attempt);
  else {
    await tx.$queryRaw`SELECT "id" FROM "whatsapp"."ConversationMessage" WHERE "id"=${input.outboundMessageId} FOR UPDATE`;
    const message = await readInitialMessage(tx, input.outboundMessageId);
    if (!message || (attempt.status !== "PENDING" && attempt.status !== "CAPACITY_BLOCKED") || attempt.sentAt || attempt.failureCode || message.status !== "PENDING" || message.providerDispatchKey || message.providerDispatchAdmittedAt || message.providerDispatchControlRevision !== null || message.providerMessageId || message.sentAt || message.deliveredAt || message.readAt || message.providerFailureCode || message.failedAt) return { kind: "held", reason: "message-not-pre-permit" };
    await validateInitialMessageIdentity(tx, input, attempt, message, true);
  }
  setStage("source_lookup");
  const source = await findExactRecoveryReservationSource(tx, input.shopId, input.outreachAttemptId);
  if (!source) return input.outboundMessageId === null ? { kind: "absent" } : { kind: "held", reason: "lineage-conflict" };
  setStage("source_lookup", source.kind);
  const reservation = source.reservation;
  if (reservation.status !== UsageReservationStatus.RESERVED) return { kind: "held", reason: "reservation-not-reserved", reservationId: reservation.id, sourceKey: reservation.sourceKey };
  if (reservation.expiresAt && reservation.expiresAt <= now) return { kind: "held", reason: "reservation-expired", reservationId: reservation.id, sourceKey: reservation.sourceKey };
  if (reservation.committedUsageEventId || reservation.compensationUsageEventId || reservation.compensationReason || reservation.compensationDisposition || reservation.compensatedAt) return { kind: "held", reason: "lineage-conflict", reservationId: reservation.id, sourceKey: reservation.sourceKey };
  setStage("policy");
  let policy;
  try { policy = await new EffectiveBillingPolicyResolver(tx).resolve(input.shopId); }
  catch (error) {
    if (error instanceof EffectiveBillingPolicyError && error.reason === "NO_CONTRACT") {
      try { policy = await new PostContractRecoveryPolicyResolver(tx).resolve(input.shopId); }
      catch (postError) { if (postError instanceof PostContractRecoveryPolicyError && (postError.reason === "CONTRACT_REQUIRED" || postError.reason === "SHOP_UNAVAILABLE")) throw new ExistingHoldSignal("contract-required", { reservationId: reservation.id, sourceKey: reservation.sourceKey }, postError); throw postError; }
    } else if (error instanceof EffectiveBillingPolicyError && error.reason === "SUBSCRIPTION_FROZEN") throw new ExistingHoldSignal("subscription-frozen", { reservationId: reservation.id, sourceKey: reservation.sourceKey }, error);
    else if (error instanceof EffectiveBillingPolicyError && (error.reason === "SHOP_UNAVAILABLE" || error.reason === "UNMAPPED_PLAN")) throw new ExistingHoldSignal("contract-required", { reservationId: reservation.id, sourceKey: reservation.sourceKey }, error);
    else throw error;
  }
  if ("features" in policy && !policy.features.has("checkout_recovery")) return { kind: "held", reason: "feature-unavailable", reservationId: reservation.id, sourceKey: reservation.sourceKey };
  if (policy.newRecoveriesPaused) return { kind: "held", reason: "paused", reservationId: reservation.id, sourceKey: reservation.sourceKey };
  if (source.kind === "paid" && (!('planKind' in policy) || policy.planKind !== "PAID_METERED" || policy.subscriptionStatus === "FROZEN" || policy.billingPeriod?.phase !== "ACTIVE" || policy.billingPeriod.status !== BillingPeriodStatus.OPEN || policy.billingPeriod.id !== await paidPeriodId(tx, reservation))) return { kind: "held", reason: "paid-period-not-current", reservationId: reservation.id, sourceKey: reservation.sourceKey };
  if (source.kind === "promotional" && !await promotionalRecoveryReservationService.isReservedSourceEligibleInExistingTransaction(tx, { shopId: input.shopId, reservationId: reservation.id, sourceKey: reservation.sourceKey, now })) return { kind: "held", reason: "source-policy-mismatch", reservationId: reservation.id, sourceKey: reservation.sourceKey };
  if (source.kind === "purchased") {
    const [counter, lot] = await Promise.all([
      tx.shopEntitlementCounter.findUnique({ where: { id: reservation.counterId! }, select: { reservedQuantity: true } }),
      tx.recoveryCreditPurchase.findUnique({ where: { id: reservation.purchasedCreditPurchaseId! }, select: { status: true, reservedAmount: true } }),
    ]);
    if (!counter || counter.reservedQuantity < reservation.quantity || !lot || (lot.status !== "ACTIVE" && lot.status !== "WITHDRAWN") || lot.reservedAmount < reservation.quantity) return { kind: "held", reason: "source-policy-mismatch", reservationId: reservation.id, sourceKey: reservation.sourceKey };
  }
  if (source.kind === "free") {
    const counter = await tx.shopEntitlementCounter.findUnique({ where: { id: reservation.counterId! }, select: { reservedQuantity: true } });
    if (!counter || counter.reservedQuantity < reservation.quantity) return { kind: "held", reason: "source-policy-mismatch", reservationId: reservation.id, sourceKey: reservation.sourceKey };
  }
  const kind = source.kind === "free" ? "lifetime-free" : source.kind;
  const admission: RecoveryBillingAdmission = { kind, sourceKey: reservation.sourceKey, policy } as RecoveryBillingAdmission;
  return { kind: "admitted", admission, reservationId: reservation.id };
}