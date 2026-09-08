import {
  Prisma,
  ShopifyReportState,
  UsageMetric,
  UsageReservationStatus,
} from "@prisma/client";
import type { PrismaClient, UsageReservation } from "@prisma/client";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";

import prisma from "../lib/db.js";

const MAX_TRANSACTION_RETRIES = 3;

export type PurchasedRecoveryReservationInput = {
  shopId: string;
  sourceKey: string;
  quantity?: number;
};

export type PurchasedReservationOutcome =
  | { kind: "reserved"; reservation: UsageReservation }
  | { kind: "committed"; reservation: UsageReservation }
  | { kind: "released"; reservation: UsageReservation }
  | { kind: "ambiguous"; reservation: UsageReservation }
  | { kind: "already-reserved"; reservation: UsageReservation }
  | { kind: "already-committed"; reservation: UsageReservation }
  | { kind: "already-released"; reservation: UsageReservation }
  | { kind: "already-ambiguous"; reservation: UsageReservation }
  | { kind: "credits-exhausted"; available: number };

export class PurchasedRecoveryReservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchasedRecoveryReservationError";
  }
}

type ReservationTransaction = Prisma.TransactionClient;
type ReservationDatabase = Pick<
  PrismaClient,
  "$transaction" | "usageReservation" | "shopEntitlementCounter" | "usageEvent"
>;

class ReservationConcurrencyConflict extends Error {}

export class PurchasedRecoveryReservationService {
  constructor(
    private readonly database: ReservationDatabase = prisma,
    private readonly maxRetries = MAX_TRANSACTION_RETRIES,
  ) {}

  async reserve(input: PurchasedRecoveryReservationInput): Promise<PurchasedReservationOutcome> {
    const quantity = validateQuantity(input.quantity);
    return this.withRetry(() =>
      this.database.$transaction(
        (transaction) => this.reserveInTransaction(transaction, input, quantity),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async commit(input: PurchasedRecoveryReservationInput): Promise<PurchasedReservationOutcome> {
    const quantity = validateQuantity(input.quantity);
    return this.withRetry(() =>
      this.database.$transaction(
        (transaction) => this.commitInTransaction(transaction, input, quantity),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async release(input: PurchasedRecoveryReservationInput): Promise<PurchasedReservationOutcome> {
    const quantity = validateQuantity(input.quantity);
    return this.withRetry(() =>
      this.database.$transaction(
        (transaction) => this.releaseInTransaction(transaction, input, quantity),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async markAmbiguous(input: PurchasedRecoveryReservationInput): Promise<PurchasedReservationOutcome> {
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
    input: PurchasedRecoveryReservationInput,
    quantity: number,
  ): Promise<PurchasedReservationOutcome> {
    const existing = await transaction.usageReservation.findUnique({
      where: { sourceKey: input.sourceKey },
    });
    if (existing) {
      assertReservationShop(existing, input.shopId);
      return replayOutcome(existing);
    }

    let counter = await transaction.shopEntitlementCounter.findUnique({
      where: {
        shopId_counter: {
          shopId: input.shopId,
          counter: "PURCHASED_RECOVERY_CREDITS",
        },
      },
    });
    if (!counter) {
      try {
        counter = await transaction.shopEntitlementCounter.create({
          data: {
            shopId: input.shopId,
            counter: "PURCHASED_RECOVERY_CREDITS",
          },
        });
      } catch (error) {
        if (isUniqueConflict(error)) throw new ReservationConcurrencyConflict();
        throw error;
      }
    }

    const available = counter.grantedQuantity - counter.committedQuantity - counter.reservedQuantity;
    if (available < quantity) return { kind: "credits-exhausted", available: Math.max(available, 0) };

    const updated = await transaction.shopEntitlementCounter.updateMany({
      where: { id: counter.id, version: counter.version },
      data: {
        reservedQuantity: { increment: quantity },
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new ReservationConcurrencyConflict();

    const reservation = await transaction.usageReservation.create({
      data: {
        shopId: input.shopId,
        counterId: counter.id,
        sourceKey: input.sourceKey,
        quantity,
      },
    });
    return { kind: "reserved", reservation };
  }

  private async commitInTransaction(
    transaction: ReservationTransaction,
    input: PurchasedRecoveryReservationInput,
    quantity: number,
  ): Promise<PurchasedReservationOutcome> {
    const reservation = await this.requireReservation(transaction, input);
    if (reservation.status !== UsageReservationStatus.RESERVED) return replayOutcome(reservation);
    if (reservation.quantity !== quantity) {
      throw new PurchasedRecoveryReservationError("Reservation quantity does not match the requested transition");
    }

    const counter = await transaction.shopEntitlementCounter.findUnique({
      where: { id: reservation.counterId },
      select: { version: true },
    });
    if (!counter) throw new PurchasedRecoveryReservationError("Reservation counter does not exist");

    const updatedCounter = await transaction.shopEntitlementCounter.updateMany({
      where: {
        id: reservation.counterId,
        version: counter.version,
        reservedQuantity: { gte: quantity },
      },
      data: {
        reservedQuantity: { decrement: quantity },
        committedQuantity: { increment: quantity },
        version: { increment: 1 },
      },
    });
    if (updatedCounter.count !== 1) throw new ReservationConcurrencyConflict();

    const usageEvent = await transaction.usageEvent.create({
      data: {
        shopId: input.shopId,
        metric: UsageMetric.RECOVERY_CONVERSATION,
        quantity,
        idempotencyKey: createRecoveryIdempotencyKey(input.shopId, input.sourceKey),
        sourceType: "PURCHASED_RECOVERY_CREDITS",
        sourceId: reservation.id,
        shopifyReportState: ShopifyReportState.NOT_APPLICABLE,
      },
    });
    const committed = await transaction.usageReservation.update({
      where: { id: reservation.id },
      data: {
        status: UsageReservationStatus.COMMITTED,
        committedUsageEventId: usageEvent.id,
      },
    });
    return { kind: "committed", reservation: committed };
  }

  private async releaseInTransaction(
    transaction: ReservationTransaction,
    input: PurchasedRecoveryReservationInput,
    quantity: number,
  ): Promise<PurchasedReservationOutcome> {
    const reservation = await this.requireReservation(transaction, input);
    if (reservation.status === UsageReservationStatus.COMMITTED) {
      throw new PurchasedRecoveryReservationError("Committed reservations cannot be released");
    }
    if (reservation.status !== UsageReservationStatus.RESERVED) return replayOutcome(reservation);
    if (reservation.quantity !== quantity) {
      throw new PurchasedRecoveryReservationError("Reservation quantity does not match the requested transition");
    }

    const counter = await transaction.shopEntitlementCounter.findUnique({
      where: { id: reservation.counterId },
      select: { version: true },
    });
    if (!counter) throw new PurchasedRecoveryReservationError("Reservation counter does not exist");

    const updatedCounter = await transaction.shopEntitlementCounter.updateMany({
      where: {
        id: reservation.counterId,
        version: counter.version,
        reservedQuantity: { gte: quantity },
      },
      data: {
        reservedQuantity: { decrement: quantity },
        version: { increment: 1 },
      },
    });
    if (updatedCounter.count !== 1) throw new ReservationConcurrencyConflict();

    const released = await transaction.usageReservation.update({
      where: { id: reservation.id },
      data: { status: UsageReservationStatus.RELEASED },
    });
    return { kind: "released", reservation: released };
  }

  private async markAmbiguousInTransaction(
    transaction: ReservationTransaction,
    input: PurchasedRecoveryReservationInput,
  ): Promise<PurchasedReservationOutcome> {
    const reservation = await this.requireReservation(transaction, input);
    if (reservation.status !== UsageReservationStatus.RESERVED) return replayOutcome(reservation);
    const ambiguous = await transaction.usageReservation.update({
      where: { id: reservation.id },
      data: { status: UsageReservationStatus.AMBIGUOUS },
    });
    return { kind: "ambiguous", reservation: ambiguous };
  }

  private async requireReservation(
    transaction: ReservationTransaction,
    input: PurchasedRecoveryReservationInput,
  ): Promise<UsageReservation> {
    const reservation = await transaction.usageReservation.findUnique({
      where: { sourceKey: input.sourceKey },
    });
    if (!reservation) throw new PurchasedRecoveryReservationError("Reservation does not exist");
    if (reservation.shopId !== input.shopId) {
      throw new PurchasedRecoveryReservationError("Reservation belongs to another shop");
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
    throw new PurchasedRecoveryReservationError("Reservation retry limit exceeded");
  }
}

function validateQuantity(quantity: number | undefined): number {
  const value = quantity ?? 1;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PurchasedRecoveryReservationError("Reservation quantity must be a positive safe integer");
  }
  return value;
}

function replayOutcome(reservation: UsageReservation): PurchasedReservationOutcome {
  switch (reservation.status) {
    case UsageReservationStatus.RESERVED:
      return { kind: "already-reserved", reservation };
    case UsageReservationStatus.COMMITTED:
      return { kind: "already-committed", reservation };
    case UsageReservationStatus.RELEASED:
      return { kind: "already-released", reservation };
    case UsageReservationStatus.AMBIGUOUS:
      return { kind: "already-ambiguous", reservation };
  }
}

function assertReservationShop(reservation: UsageReservation, shopId: string): void {
  if (reservation.shopId !== shopId) {
    throw new PurchasedRecoveryReservationError("Reservation belongs to another shop");
  }
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isRetryableConflict(error: unknown): boolean {
  return error instanceof ReservationConcurrencyConflict ||
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2002" || error.code === "P2034"));
}

export const purchasedRecoveryReservationService = new PurchasedRecoveryReservationService();
