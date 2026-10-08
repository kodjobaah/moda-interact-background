import {
  Prisma,
  PromotionCampaignStatus,
  PromotionTargetScope,
  ShopifyReportState,
  UsageMetric,
  UsageReservationStatus,
} from "@prisma/client";
import type { PrismaClient, UsageReservation } from "@prisma/client";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";

import prisma from "../lib/db.js";
import { resolveRecoveryUsageProvider } from "./recovery-billing/usage-event-provider.js";
import {
  DEFAULT_RECOVERY_RESERVATION_TRANSACTION_RETRIES,
  RecoveryReservationConcurrencyConflict,
  assertRecoveryReservationShop,
  recoveryReservationReplayKind,
  recoveryReservationTransitionDecision,
  validateRecoveryReservationQuantity,
  withRecoveryReservationRetry,
} from "./recovery-reservation/reservation-lifecycle.js";
import {
  EffectiveBillingPolicyResolver,
  type BillingPolicyClient,
} from "./effective-billing-policy.service.js";

export type PromotionalRecoveryReservationInput = {
  shopId: string;
  sourceKey: string;
  planId: string;
  quantity?: number;
  now?: Date;
};

export type PromotionalReservationOutcome =
  | { kind: "reserved"; reservation: UsageReservation; sourceKey: string }
  | { kind: "committed"; reservation: UsageReservation; sourceKey: string }
  | { kind: "released"; reservation: UsageReservation; sourceKey: string }
  | { kind: "ambiguous"; reservation: UsageReservation; sourceKey: string }
  | { kind: "already-reserved"; reservation: UsageReservation; sourceKey: string }
  | { kind: "already-committed"; reservation: UsageReservation; sourceKey: string }
  | { kind: "already-released"; reservation: UsageReservation; sourceKey: string }
  | { kind: "already-ambiguous"; reservation: UsageReservation; sourceKey: string }
  | { kind: "unavailable" };

export class PromotionalRecoveryReservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionalRecoveryReservationError";
  }
}

type ReservationTransaction = Prisma.TransactionClient;
type ReservationDatabase = Pick<
  PrismaClient,
  "$transaction" | "usageReservation" | "promotionalCreditGrant" | "merchantPromotionSelection" | "usageEvent"
>;
type PolicyResolverFactory = (client: BillingPolicyClient) => Pick<EffectiveBillingPolicyResolver, "resolve">;

export class PromotionalRecoveryReservationService {
  constructor(
    private readonly database: ReservationDatabase = prisma,
    private readonly maxRetries = DEFAULT_RECOVERY_RESERVATION_TRANSACTION_RETRIES,
    private readonly now: () => Date = () => new Date(),
    private readonly createPolicyResolver: PolicyResolverFactory = (client) => new EffectiveBillingPolicyResolver(client),
  ) {}

  async reserve(input: PromotionalRecoveryReservationInput): Promise<PromotionalReservationOutcome> {
    const quantity = validateRecoveryReservationQuantity(input.quantity, (message) => new PromotionalRecoveryReservationError(message));
    return this.withRetry(() =>
      this.database.$transaction(
        (transaction) => this.reserveInTransaction(transaction, input, quantity),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async commit(input: PromotionalRecoveryReservationInput): Promise<PromotionalReservationOutcome> {
    const quantity = validateRecoveryReservationQuantity(input.quantity, (message) => new PromotionalRecoveryReservationError(message));
    return this.withRetry(() =>
      this.database.$transaction(
        (transaction) => this.commitInTransaction(transaction, input, quantity),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async release(input: PromotionalRecoveryReservationInput): Promise<PromotionalReservationOutcome> {
    const quantity = validateRecoveryReservationQuantity(input.quantity, (message) => new PromotionalRecoveryReservationError(message));
    return this.withRetry(() =>
      this.database.$transaction(
        (transaction) => this.releaseInTransaction(transaction, input, quantity),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async markAmbiguous(input: PromotionalRecoveryReservationInput): Promise<PromotionalReservationOutcome> {
    validateRecoveryReservationQuantity(input.quantity, (message) => new PromotionalRecoveryReservationError(message));
    return this.withRetry(() =>
      this.database.$transaction(
        (transaction) => this.markAmbiguousInTransaction(transaction, input),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  private async reserveInTransaction(
    transaction: ReservationTransaction,
    input: PromotionalRecoveryReservationInput,
    quantity: number,
  ): Promise<PromotionalReservationOutcome> {
    const existing = await transaction.usageReservation.findUnique({
      where: { sourceKey: input.sourceKey },
    });
    if (existing) {
      assertRecoveryReservationShop(existing, input.shopId, (message) => new PromotionalRecoveryReservationError(message));
      if (existing.promotionalCreditGrantId === null) return { kind: "unavailable" };
      const transition = recoveryReservationTransitionDecision({
        reservation: existing,
        transition: "reactivate",
        requestedQuantity: quantity,
        createError: (message) => new PromotionalRecoveryReservationError(message),
      });
      if (transition.kind === "apply") {
        const grant = await this.findUsableGrant(transaction, input);
        if (!grant || grant.id !== existing.promotionalCreditGrantId || availableQuantity(grant) < quantity) {
          return { kind: "already-released", reservation: existing, sourceKey: input.sourceKey };
        }
        await this.reserveGrant(transaction, grant, quantity);
        const reactivated = await transaction.usageReservation.update({
          where: { id: existing.id },
          data: { status: UsageReservationStatus.RESERVED },
        });
        return { kind: "reserved", reservation: reactivated, sourceKey: input.sourceKey };
      }
      return replayOutcome(existing, input.sourceKey);
    }

    const grant = await this.findUsableGrant(transaction, input);
    if (!grant || availableQuantity(grant) < quantity) return { kind: "unavailable" };

    await this.reserveGrant(transaction, grant, quantity);
    const reservation = await transaction.usageReservation.create({
      data: {
        shopId: input.shopId,
        promotionalCreditGrantId: grant.id,
        sourceKey: input.sourceKey,
        quantity,
      },
    });
    return { kind: "reserved", reservation, sourceKey: input.sourceKey };
  }

  private async commitInTransaction(
    transaction: ReservationTransaction,
    input: PromotionalRecoveryReservationInput,
    quantity: number,
  ): Promise<PromotionalReservationOutcome> {
    const reservation = await this.requirePromotionalReservation(transaction, input);
    const transition = recoveryReservationTransitionDecision({
      reservation,
      transition: "commit",
      requestedQuantity: quantity,
      createError: (message) => new PromotionalRecoveryReservationError(message),
    });
    if (transition.kind === "replay") {
      return replayOutcome(reservation, input.sourceKey);
    }

    const grant = await transaction.promotionalCreditGrant.findUnique({
      where: { id: reservation.promotionalCreditGrantId ?? "" },
    });
    if (!grant || grant.shopId !== input.shopId || grant.reservedQuantity < quantity) {
      throw new PromotionalRecoveryReservationError("Promotional grant does not exist or has insufficient reservation");
    }
    const now = input.now ?? this.now();
    const committedAfter = grant.committedQuantity + quantity;
    const reservedAfter = grant.reservedQuantity - quantity;
    const remainingAfterCommit = grant.quantity - committedAfter - reservedAfter;
    if (reservedAfter < 0 || remainingAfterCommit < 0) {
      throw new PromotionalRecoveryReservationError("Promotional grant accounting would become negative");
    }
    const exhaustedAt = grant.exhaustedAt ?? (remainingAfterCommit === 0 ? now : undefined);
    const updatedGrant = await transaction.promotionalCreditGrant.updateMany({
      where: { id: grant.id, version: grant.version, reservedQuantity: { gte: quantity } },
      data: {
        reservedQuantity: { decrement: quantity },
        committedQuantity: { increment: quantity },
        firstUsedAt: grant.firstUsedAt ?? now,
        lastUsedAt: now,
        ...(exhaustedAt !== undefined ? { exhaustedAt } : {}),
        version: { increment: 1 },
      },
    });
    if (updatedGrant.count !== 1) throw new RecoveryReservationConcurrencyConflict();

    const provider = await resolveRecoveryUsageProvider(transaction, input.shopId);
    const usageEvent = await transaction.usageEvent.create({
      data: {
        shopId: input.shopId,
        metric: UsageMetric.RECOVERY_CONVERSATION,
        quantity,
        idempotencyKey: createRecoveryIdempotencyKey(input.shopId, input.sourceKey),
        sourceType: "PROMOTIONAL_RECOVERY_CREDITS",
        sourceId: reservation.id,
        provider,
        shopifyReportState: ShopifyReportState.NOT_APPLICABLE,
      },
    });
    const committed = await transaction.usageReservation.update({
      where: { id: reservation.id },
      data: { status: UsageReservationStatus.COMMITTED, committedUsageEventId: usageEvent.id },
    });
    return { kind: "committed", reservation: committed, sourceKey: input.sourceKey };
  }

  private async releaseInTransaction(
    transaction: ReservationTransaction,
    input: PromotionalRecoveryReservationInput,
    quantity: number,
  ): Promise<PromotionalReservationOutcome> {
    const reservation = await this.requirePromotionalReservation(transaction, input);
    const transition = recoveryReservationTransitionDecision({
      reservation,
      transition: "release",
      requestedQuantity: quantity,
      createError: (message) => new PromotionalRecoveryReservationError(message),
    });
    if (transition.kind === "replay") {
      return replayOutcome(reservation, input.sourceKey);
    }
    const grant = await transaction.promotionalCreditGrant.findUnique({
      where: { id: reservation.promotionalCreditGrantId ?? "" },
    });
    if (!grant || grant.shopId !== input.shopId || grant.reservedQuantity < quantity) {
      throw new PromotionalRecoveryReservationError("Promotional grant does not exist or has insufficient reservation");
    }
    const updatedGrant = await transaction.promotionalCreditGrant.updateMany({
      where: { id: grant.id, version: grant.version, reservedQuantity: { gte: quantity } },
      data: { reservedQuantity: { decrement: quantity }, version: { increment: 1 } },
    });
    if (updatedGrant.count !== 1) throw new RecoveryReservationConcurrencyConflict();
    const released = await transaction.usageReservation.update({
      where: { id: reservation.id },
      data: { status: UsageReservationStatus.RELEASED },
    });
    return { kind: "released", reservation: released, sourceKey: input.sourceKey };
  }

  private async markAmbiguousInTransaction(
    transaction: ReservationTransaction,
    input: PromotionalRecoveryReservationInput,
  ): Promise<PromotionalReservationOutcome> {
    const reservation = await this.requirePromotionalReservation(transaction, input);
    const transition = recoveryReservationTransitionDecision({
      reservation,
      transition: "ambiguous",
      createError: (message) => new PromotionalRecoveryReservationError(message),
    });
    if (transition.kind === "replay") {
      return replayOutcome(reservation, input.sourceKey);
    }
    const ambiguous = await transaction.usageReservation.update({
      where: { id: reservation.id },
      data: { status: UsageReservationStatus.AMBIGUOUS },
    });
    return { kind: "ambiguous", reservation: ambiguous, sourceKey: input.sourceKey };
  }

  private async findUsableGrant(
    transaction: ReservationTransaction,
    input: PromotionalRecoveryReservationInput,
  ) {
    const now = input.now ?? this.now();
    const policy = await this.createPolicyResolver(transaction).resolve(input.shopId, now);
    if (policy.newRecoveriesPaused) return null;
    const selection = await transaction.merchantPromotionSelection.findUnique({
      where: { shopId: input.shopId },
      include: { promotionalCreditGrant: { include: { campaign: true } } },
    });
    const grant = selection?.promotionalCreditGrant;
    const campaign = grant?.campaign;
    if (!grant || !campaign || grant.shopId !== input.shopId || campaign.status !== PromotionCampaignStatus.ACTIVE) return null;
    if (campaign.startsAt > now || campaign.expiresAt <= now || grant.campaignId !== campaign.id) return null;
    if (
      (campaign.scope === PromotionTargetScope.SHOP && campaign.targetShopId !== input.shopId) ||
      (campaign.scope === PromotionTargetScope.PLAN && campaign.targetPlanId !== policy.planId) ||
      (campaign.scope === PromotionTargetScope.GLOBAL && (campaign.targetShopId !== null || campaign.targetPlanId !== null))
    ) return null;
    return grant;
  }

  private async reserveGrant(
    transaction: ReservationTransaction,
    grant: NonNullable<Awaited<ReturnType<PromotionalRecoveryReservationService["findUsableGrant"]>>>,
    quantity: number,
  ): Promise<void> {
    const updatedGrant = await transaction.promotionalCreditGrant.updateMany({
      where: {
        id: grant.id,
        version: grant.version,
        reservedQuantity: { lte: grant.quantity - grant.committedQuantity - quantity },
      },
      data: {
        reservedQuantity: { increment: quantity },
        version: { increment: 1 },
      },
    });
    if (updatedGrant.count !== 1) throw new RecoveryReservationConcurrencyConflict();
  }

  private async requirePromotionalReservation(
    transaction: ReservationTransaction,
    input: PromotionalRecoveryReservationInput,
  ): Promise<UsageReservation> {
    const reservation = await transaction.usageReservation.findUnique({ where: { sourceKey: input.sourceKey } });
    if (!reservation) throw new PromotionalRecoveryReservationError("Reservation does not exist");
    assertRecoveryReservationShop(reservation, input.shopId, (message) => new PromotionalRecoveryReservationError(message));
    if (!reservation.promotionalCreditGrantId) {
      throw new PromotionalRecoveryReservationError("Reservation is not promotional");
    }
    return reservation;
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    return withRecoveryReservationRetry({
      operation,
      maxRetries: this.maxRetries,
      createRetryLimitError: (message) => new PromotionalRecoveryReservationError(message),
    });
  }
}


function availableQuantity(grant: { quantity: number; committedQuantity: number; reservedQuantity: number }): number {
  return grant.quantity - grant.committedQuantity - grant.reservedQuantity;
}

function replayOutcome(reservation: UsageReservation, sourceKey: string): PromotionalReservationOutcome {
  return { kind: recoveryReservationReplayKind(reservation.status), reservation, sourceKey };
}


export const promotionalRecoveryReservationService = new PromotionalRecoveryReservationService();
