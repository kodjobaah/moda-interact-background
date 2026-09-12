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
import { EffectiveBillingPolicyResolver } from "./effective-billing-policy.service.js";

const MAX_TRANSACTION_RETRIES = 3;

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

class ReservationConcurrencyConflict extends Error {}

type ReservationTransaction = Prisma.TransactionClient;
type ReservationDatabase = Pick<
  PrismaClient,
  "$transaction" | "usageReservation" | "promotionalCreditGrant" | "merchantPromotionSelection" | "usageEvent"
>;

export class PromotionalRecoveryReservationService {
  constructor(
    private readonly database: ReservationDatabase = prisma,
    private readonly maxRetries = MAX_TRANSACTION_RETRIES,
  ) {}

  async reserve(input: PromotionalRecoveryReservationInput): Promise<PromotionalReservationOutcome> {
    const quantity = validateQuantity(input.quantity);
    return this.withRetry(() =>
      this.database.$transaction(
        (transaction) => this.reserveInTransaction(transaction, input, quantity),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async commit(input: PromotionalRecoveryReservationInput): Promise<PromotionalReservationOutcome> {
    const quantity = validateQuantity(input.quantity);
    return this.withRetry(() =>
      this.database.$transaction(
        (transaction) => this.commitInTransaction(transaction, input, quantity),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async release(input: PromotionalRecoveryReservationInput): Promise<PromotionalReservationOutcome> {
    const quantity = validateQuantity(input.quantity);
    return this.withRetry(() =>
      this.database.$transaction(
        (transaction) => this.releaseInTransaction(transaction, input, quantity),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async markAmbiguous(input: PromotionalRecoveryReservationInput): Promise<PromotionalReservationOutcome> {
    validateQuantity(input.quantity);
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
      assertReservationShop(existing, input.shopId);
      if (existing.promotionalCreditGrantId === null) return { kind: "unavailable" };
      if (existing.status === UsageReservationStatus.RELEASED) {
        if (existing.quantity !== quantity) {
          throw new PromotionalRecoveryReservationError("Reservation quantity does not match the requested transition");
        }
        const grant = await this.findUsableGrant(transaction, input);
        if (!grant || grant.id !== existing.promotionalCreditGrantId || availableQuantity(grant) < quantity) {
          return { kind: "already-released", reservation: existing, sourceKey: input.sourceKey };
        }
        await this.reserveGrant(transaction, grant, quantity, input.now ?? new Date());
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

    await this.reserveGrant(transaction, grant, quantity, input.now ?? new Date());
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
    if (reservation.status !== UsageReservationStatus.RESERVED) {
      return replayOutcome(reservation, input.sourceKey);
    }
    if (reservation.quantity !== quantity) {
      throw new PromotionalRecoveryReservationError("Reservation quantity does not match the requested transition");
    }

    const grant = await transaction.promotionalCreditGrant.findUnique({
      where: { id: reservation.promotionalCreditGrantId ?? "" },
    });
    if (!grant || grant.shopId !== input.shopId || grant.reservedQuantity < quantity) {
      throw new PromotionalRecoveryReservationError("Promotional grant does not exist or has insufficient reservation");
    }
    const now = input.now ?? new Date();
    const remainingAfterCommit = grant.quantity - grant.committedQuantity - grant.reservedQuantity;
    const updatedGrant = await transaction.promotionalCreditGrant.updateMany({
      where: { id: grant.id, version: grant.version, reservedQuantity: { gte: quantity } },
      data: {
        reservedQuantity: { decrement: quantity },
        committedQuantity: { increment: quantity },
        firstUsedAt: grant.firstUsedAt ?? now,
        lastUsedAt: now,
        exhaustedAt: remainingAfterCommit <= quantity ? now : grant.exhaustedAt,
        version: { increment: 1 },
      },
    });
    if (updatedGrant.count !== 1) throw new ReservationConcurrencyConflict();

    const usageEvent = await transaction.usageEvent.create({
      data: {
        shopId: input.shopId,
        metric: UsageMetric.RECOVERY_CONVERSATION,
        quantity,
        idempotencyKey: createRecoveryIdempotencyKey(input.shopId, input.sourceKey),
        sourceType: "PROMOTIONAL_RECOVERY_CREDITS",
        sourceId: reservation.id,
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
    if (reservation.status === UsageReservationStatus.COMMITTED) {
      throw new PromotionalRecoveryReservationError("Committed reservations cannot be released");
    }
    if (reservation.status !== UsageReservationStatus.RESERVED) {
      return replayOutcome(reservation, input.sourceKey);
    }
    if (reservation.quantity !== quantity) {
      throw new PromotionalRecoveryReservationError("Reservation quantity does not match the requested transition");
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
    if (updatedGrant.count !== 1) throw new ReservationConcurrencyConflict();
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
    if (reservation.status !== UsageReservationStatus.RESERVED) {
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
    const now = input.now ?? new Date();
    const policy = await new EffectiveBillingPolicyResolver(transaction).resolve(input.shopId, now);
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
    now: Date,
  ): Promise<void> {
    const updatedGrant = await transaction.promotionalCreditGrant.updateMany({
      where: {
        id: grant.id,
        version: grant.version,
        reservedQuantity: { lte: grant.quantity - grant.committedQuantity - quantity },
      },
      data: {
        reservedQuantity: { increment: quantity },
        firstSelectedAt: grant.firstSelectedAt ?? now,
        lastSelectedAt: now,
        selectionCount: { increment: 1 },
        version: { increment: 1 },
      },
    });
    if (updatedGrant.count !== 1) throw new ReservationConcurrencyConflict();
  }

  private async requirePromotionalReservation(
    transaction: ReservationTransaction,
    input: PromotionalRecoveryReservationInput,
  ): Promise<UsageReservation> {
    const reservation = await transaction.usageReservation.findUnique({ where: { sourceKey: input.sourceKey } });
    if (!reservation) throw new PromotionalRecoveryReservationError("Reservation does not exist");
    assertReservationShop(reservation, input.shopId);
    if (!reservation.promotionalCreditGrantId) {
      throw new PromotionalRecoveryReservationError("Reservation is not promotional");
    }
    return reservation;
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isRetryableConflict(error) || attempt === this.maxRetries - 1) throw error;
      }
    }
    throw new PromotionalRecoveryReservationError("Reservation retry limit exceeded");
  }
}

function validateQuantity(quantity: number | undefined): number {
  const value = quantity ?? 1;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PromotionalRecoveryReservationError("Reservation quantity must be a positive safe integer");
  }
  return value;
}

function availableQuantity(grant: { quantity: number; committedQuantity: number; reservedQuantity: number }): number {
  return grant.quantity - grant.committedQuantity - grant.reservedQuantity;
}

function replayOutcome(reservation: UsageReservation, sourceKey: string): PromotionalReservationOutcome {
  switch (reservation.status) {
    case UsageReservationStatus.RESERVED:
      return { kind: "already-reserved", reservation, sourceKey };
    case UsageReservationStatus.COMMITTED:
      return { kind: "already-committed", reservation, sourceKey };
    case UsageReservationStatus.RELEASED:
      return { kind: "already-released", reservation, sourceKey };
    case UsageReservationStatus.AMBIGUOUS:
      return { kind: "already-ambiguous", reservation, sourceKey };
  }
}

function assertReservationShop(reservation: UsageReservation, shopId: string): void {
  if (reservation.shopId !== shopId) {
    throw new PromotionalRecoveryReservationError("Reservation belongs to another shop");
  }
}

function isRetryableConflict(error: unknown): boolean {
  return error instanceof ReservationConcurrencyConflict ||
    (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034"));
}

export const promotionalRecoveryReservationService = new PromotionalRecoveryReservationService();