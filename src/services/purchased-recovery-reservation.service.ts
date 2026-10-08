import {
  Prisma,
  RecoveryCreditPurchaseStatus,
  ShopifyReportState,
  UsageMetric,
  UsageReservationStatus,
} from "@prisma/client";
import type { PrismaClient, UsageReservation } from "@prisma/client";
import {
  availablePurchasedRecoveryCredits,
  createRecoveryIdempotencyKey,
  deriveShopifyProviderContextIdentity,
  isSameShopifyPurchaseProviderContext,
} from "@modainteract/moda-interact-shared/billing";

import prisma from "../lib/db.js";
import {
  DEFAULT_RECOVERY_RESERVATION_TRANSACTION_RETRIES,
  RecoveryReservationConcurrencyConflict,
  assertRecoveryReservationShop,
  isRecoveryReservationUniqueConflict,
  recoveryReservationReplayKind,
  recoveryReservationTransitionDecision,
  validateRecoveryReservationQuantity,
  withRecoveryReservationRetry,
} from "./recovery-reservation/reservation-lifecycle.js";

export type PurchasedRecoveryReservationInput = {
  shopId: string;
  sourceKey: string;
  quantity?: number;
};

export type ReservationCounter = "PURCHASED_RECOVERY_CREDITS" | "LIFETIME_FREE_RECOVERY_CREDITS";

export type PurchasedReservationOutcome =
  | { kind: "reserved"; reservation: UsageReservation; counter: ReservationCounter }
  | { kind: "committed"; reservation: UsageReservation }
  | { kind: "released"; reservation: UsageReservation }
  | { kind: "ambiguous"; reservation: UsageReservation }
  | { kind: "already-reserved"; reservation: UsageReservation; counter: ReservationCounter }
  | { kind: "already-committed"; reservation: UsageReservation; counter: ReservationCounter }
  | { kind: "already-released"; reservation: UsageReservation; counter: ReservationCounter }
  | { kind: "already-ambiguous"; reservation: UsageReservation; counter: ReservationCounter }
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
  "$transaction" | "usageReservation" | "shopEntitlementCounter" | "usageEvent" | "recoveryCreditRefund" | "subscription"
> & Pick<PrismaClient, "recoveryCreditPurchase">;

export class PurchasedRecoveryReservationService {
  constructor(
    private readonly database: ReservationDatabase = prisma,
    private readonly maxRetries = DEFAULT_RECOVERY_RESERVATION_TRANSACTION_RETRIES,
  ) {}

  async reserve(input: PurchasedRecoveryReservationInput): Promise<PurchasedReservationOutcome> {
    const quantity = validateRecoveryReservationQuantity(input.quantity, (message) => new PurchasedRecoveryReservationError(message));
    return this.withRetry(() =>
      this.database.$transaction(
        (transaction) => this.reserveInTransaction(transaction, input, quantity),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async commit(input: PurchasedRecoveryReservationInput): Promise<PurchasedReservationOutcome> {
    const quantity = validateRecoveryReservationQuantity(input.quantity, (message) => new PurchasedRecoveryReservationError(message));
    return this.withRetry(() =>
      this.database.$transaction(
        (transaction) => this.commitInTransaction(transaction, input, quantity),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async release(input: PurchasedRecoveryReservationInput): Promise<PurchasedReservationOutcome> {
    const quantity = validateRecoveryReservationQuantity(input.quantity, (message) => new PurchasedRecoveryReservationError(message));
    return this.withRetry(() =>
      this.database.$transaction(
        (transaction) => this.releaseInTransaction(transaction, input, quantity),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async markAmbiguous(input: PurchasedRecoveryReservationInput): Promise<PurchasedReservationOutcome> {
    validateRecoveryReservationQuantity(input.quantity, (message) => new PurchasedRecoveryReservationError(message));
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
      assertRecoveryReservationShop(existing, input.shopId, (message) => new PurchasedRecoveryReservationError(message));
      const counter = await this.readReservationCounter(transaction, existing);
      if (counter === "PURCHASED_RECOVERY_CREDITS") {
        const transition = recoveryReservationTransitionDecision({
          reservation: existing,
          transition: "reactivate",
          requestedQuantity: quantity,
          createError: (message) => new PurchasedRecoveryReservationError(message),
        });
        if (transition.kind === "replay") return replayOutcome(existing, counter);
        const purchasedCounter = await transaction.shopEntitlementCounter.findUnique({
          where: { id: existing.counterId ?? "" },
        });
        if (!purchasedCounter) {
          throw new PurchasedRecoveryReservationError("Reservation counter does not exist");
        }
        const available = availablePurchasedRecoveryCredits({
          grantedQuantity: purchasedCounter.grantedQuantity,
          committedQuantity: purchasedCounter.committedQuantity,
          reservedQuantity: purchasedCounter.reservedQuantity,
          refundingQuantity: purchasedCounter.refundingQuantity ?? 0,
        });
        if (available < quantity) return replayOutcome(existing, counter);
        const originalLot = await findPurchaseLot(transaction, existing.purchasedCreditPurchaseId);
        const lot = originalLot && originalLot.status === RecoveryCreditPurchaseStatus.ACTIVE && spendableLotQuantity(originalLot) >= quantity
          ? originalLot
          : await selectOldestSpendableLot(transaction, input.shopId, quantity);
        if (!lot) return replayOutcome(existing, counter);
        const updatedCounter = await transaction.shopEntitlementCounter.updateMany({
          where: { id: purchasedCounter.id, version: purchasedCounter.version },
          data: {
            reservedQuantity: { increment: quantity },
            version: { increment: 1 },
          },
        });
        if (updatedCounter.count !== 1) throw new RecoveryReservationConcurrencyConflict();
        const updatedLot = await transaction.recoveryCreditPurchase.updateMany({
          where: {
            id: lot.id,
            version: lot.version,
            status: RecoveryCreditPurchaseStatus.ACTIVE,
            currentAmount: lot.currentAmount,
            reservedAmount: lot.reservedAmount,
          },
          data: { reservedAmount: { increment: quantity }, version: { increment: 1 } },
        });
        if (updatedLot.count !== 1) throw new RecoveryReservationConcurrencyConflict();
        const reactivated = await transaction.usageReservation.update({
          where: { id: existing.id },
          data: { status: UsageReservationStatus.RESERVED, purchasedCreditPurchaseId: lot.id },
        });
        return { kind: "reserved", reservation: reactivated, counter };
      }
      return replayOutcome(existing, counter);
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
        if (isRecoveryReservationUniqueConflict(error)) throw new RecoveryReservationConcurrencyConflict();
        throw error;
      }
    }

    const available = availablePurchasedRecoveryCredits({
      grantedQuantity: counter.grantedQuantity,
      committedQuantity: counter.committedQuantity,
      reservedQuantity: counter.reservedQuantity,
      refundingQuantity: counter.refundingQuantity ?? 0,
    });
    if (available < quantity) return { kind: "credits-exhausted", available: Math.max(available, 0) };

    const lot = await selectOldestSpendableLot(transaction, input.shopId, quantity);
    if (!lot) return { kind: "credits-exhausted", available: Math.max(available, 0) };

    const updated = await transaction.shopEntitlementCounter.updateMany({
      where: { id: counter.id, version: counter.version },
      data: {
        reservedQuantity: { increment: quantity },
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) throw new RecoveryReservationConcurrencyConflict();

    const updatedLot = await transaction.recoveryCreditPurchase.updateMany({
      where: {
        id: lot.id,
        version: lot.version,
        status: RecoveryCreditPurchaseStatus.ACTIVE,
        currentAmount: lot.currentAmount,
        reservedAmount: lot.reservedAmount,
      },
      data: { reservedAmount: { increment: quantity }, version: { increment: 1 } },
    });
    if (updatedLot.count !== 1) throw new RecoveryReservationConcurrencyConflict();

    const reservation = await transaction.usageReservation.create({
      data: {
        shopId: input.shopId,
        counterId: counter.id,
        purchasedCreditPurchaseId: lot.id,
        sourceKey: input.sourceKey,
        quantity,
      },
    });
    return { kind: "reserved", reservation, counter: "PURCHASED_RECOVERY_CREDITS" };
  }

  private async commitInTransaction(
    transaction: ReservationTransaction,
    input: PurchasedRecoveryReservationInput,
    quantity: number,
  ): Promise<PurchasedReservationOutcome> {
    const reservation = await this.requireReservation(transaction, input);
    const transition = recoveryReservationTransitionDecision({
      reservation,
      transition: "commit",
      requestedQuantity: quantity,
      createError: (message) => new PurchasedRecoveryReservationError(message),
    });
    if (transition.kind === "replay") {
      return replayOutcome(reservation, "PURCHASED_RECOVERY_CREDITS");
    }

    const counterId = reservation.counterId;
    if (!counterId) throw new PurchasedRecoveryReservationError("Reservation counter does not exist");
    const lot = await requirePurchaseLot(transaction, reservation.purchasedCreditPurchaseId);
    const wasWithdrawn = lot.status === RecoveryCreditPurchaseStatus.WITHDRAWN;
    const completesPurchase = lot.currentAmount === quantity && lot.reservedAmount === quantity;
    const counter = await transaction.shopEntitlementCounter.findUnique({
      where: { id: counterId },
      select: { version: true },
    });
    if (!counter) throw new PurchasedRecoveryReservationError("Reservation counter does not exist");
    const updatedLot = await transaction.recoveryCreditPurchase.updateMany({
      where: {
        id: lot.id,
        version: lot.version,
        status: { in: [RecoveryCreditPurchaseStatus.ACTIVE, RecoveryCreditPurchaseStatus.WITHDRAWN] },
        reservedAmount: { gte: quantity },
      },
      data: {
        currentAmount: { decrement: quantity },
        reservedAmount: { decrement: quantity },
        ...(completesPurchase ? { status: RecoveryCreditPurchaseStatus.COMPLETED } : {}),
        version: { increment: 1 },
      },
    });
    if (updatedLot.count !== 1) throw new RecoveryReservationConcurrencyConflict();

    if (completesPurchase) {
      if (wasWithdrawn) {
        await transaction.recoveryCreditRefund.updateMany({
          where: {
            purchaseId: lot.id,
            status: { in: ["REQUESTED", "PROVIDER_ACTION_REQUIRED"] },
          },
          data: { status: "CANCELLED", reason: "NO_CREDITS_REMAINING", version: { increment: 1 } },
        });
      }
    }

    const updatedCounter = await transaction.shopEntitlementCounter.updateMany({
      where: {
        id: counterId,
        version: counter.version,
        reservedQuantity: { gte: quantity },
      },
      data: {
        reservedQuantity: { decrement: quantity },
        committedQuantity: { increment: quantity },
        version: { increment: 1 },
      },
    });
    if (updatedCounter.count !== 1) throw new RecoveryReservationConcurrencyConflict();

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
    const transition = recoveryReservationTransitionDecision({
      reservation,
      transition: "release",
      requestedQuantity: quantity,
      createError: (message) => new PurchasedRecoveryReservationError(message),
    });
    if (transition.kind === "replay") {
      return replayOutcome(reservation, "PURCHASED_RECOVERY_CREDITS");
    }

    const counterId = reservation.counterId;
    if (!counterId) throw new PurchasedRecoveryReservationError("Reservation counter does not exist");
    const lot = await requirePurchaseLot(transaction, reservation.purchasedCreditPurchaseId);
    const counter = await transaction.shopEntitlementCounter.findUnique({
      where: { id: counterId },
      select: { version: true },
    });
    if (!counter) throw new PurchasedRecoveryReservationError("Reservation counter does not exist");
    const updatedLot = await transaction.recoveryCreditPurchase.updateMany({
      where: {
        id: lot.id,
        version: lot.version,
        status: { in: [RecoveryCreditPurchaseStatus.ACTIVE, RecoveryCreditPurchaseStatus.WITHDRAWN] },
        reservedAmount: { gte: quantity },
      },
      data: { reservedAmount: { decrement: quantity }, version: { increment: 1 } },
    });
    if (updatedLot.count !== 1) throw new RecoveryReservationConcurrencyConflict();

    const updatedCounter = await transaction.shopEntitlementCounter.updateMany({
      where: {
        id: counterId,
        version: counter.version,
        reservedQuantity: { gte: quantity },
      },
      data: {
        reservedQuantity: { decrement: quantity },
        ...(lot.status === RecoveryCreditPurchaseStatus.WITHDRAWN
          ? { refundingQuantity: { increment: quantity } }
          : {}),
        version: { increment: 1 },
      },
    });
    if (updatedCounter.count !== 1) throw new RecoveryReservationConcurrencyConflict();

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
    const transition = recoveryReservationTransitionDecision({
      reservation,
      transition: "ambiguous",
      createError: (message) => new PurchasedRecoveryReservationError(message),
    });
    if (transition.kind === "replay") {
      return replayOutcome(reservation, "PURCHASED_RECOVERY_CREDITS");
    }
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
    assertRecoveryReservationShop(reservation, input.shopId, (message) => new PurchasedRecoveryReservationError(message));
    return reservation;
  }

  private async readReservationCounter(
    transaction: ReservationTransaction,
    reservation: UsageReservation,
  ): Promise<ReservationCounter> {
    if (!reservation.counterId) {
      throw new PurchasedRecoveryReservationError("Reservation counter does not exist");
    }
    const counter = await transaction.shopEntitlementCounter.findUnique({
      where: { id: reservation.counterId },
      select: { counter: true },
    });
    if (counter?.counter !== "PURCHASED_RECOVERY_CREDITS" && counter?.counter !== "LIFETIME_FREE_RECOVERY_CREDITS") {
      throw new PurchasedRecoveryReservationError("Reservation counter is not a recovery capacity counter");
    }
    return counter.counter;
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    return withRecoveryReservationRetry({
      operation,
      maxRetries: this.maxRetries,
      createRetryLimitError: (message) => new PurchasedRecoveryReservationError(message),
    });
  }
}


type PurchaseLot = Awaited<ReturnType<PrismaClient["recoveryCreditPurchase"]["findUnique"]>>;

async function findPurchaseLot(
  transaction: ReservationTransaction,
  purchaseId: string | null,
): Promise<NonNullable<PurchaseLot> | null> {
  if (!purchaseId) return null;
  return transaction.recoveryCreditPurchase.findUnique({ where: { id: purchaseId } });
}

async function requirePurchaseLot(
  transaction: ReservationTransaction,
  purchaseId: string | null,
): Promise<NonNullable<PurchaseLot>> {
  const lot = await findPurchaseLot(transaction, purchaseId);
  if (!lot) throw new PurchasedRecoveryReservationError("Purchased reservation lot does not exist");
  return lot;
}

async function selectOldestSpendableLot(
  transaction: ReservationTransaction,
  shopId: string,
  quantity: number,
): Promise<NonNullable<PurchaseLot> | null> {
  const [subscription, lots] = await Promise.all([
    transaction.subscription.findUnique({
      where: { shopId },
      select: {
        status: true,
        providerSubscriptionId: true,
        observedShopifyPlanHandle: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        billingPeriodId: true,
        plan: { select: { active: true } },
      },
    }),
    transaction.recoveryCreditPurchase.findMany({
      where: { shopId, status: RecoveryCreditPurchaseStatus.ACTIVE },
      orderBy: [
        { activatedAt: { sort: "asc", nulls: "last" } },
        { createdAt: "asc" },
        { id: "asc" },
      ],
    }),
  ]);

  const currentContext = deriveCurrentConsumptionContext(subscription);
  const historical = [] as NonNullable<PurchaseLot>[];
  const current = [] as NonNullable<PurchaseLot>[];
  for (const lot of lots) {
    if (
      currentContext &&
      isSameShopifyPurchaseProviderContext(
        {
          providerContextIdentity: lot.providerSubscriptionIdSnapshot,
          shopifyPlanHandleSnapshot: lot.shopifyPlanHandleSnapshot,
          billingPeriodId: lot.billingPeriodId,
        },
        currentContext,
      )
    ) {
      current.push(lot);
    } else {
      historical.push(lot);
    }
  }
  return [...historical, ...current].find((lot) => spendableLotQuantity(lot) >= quantity) ?? null;
}

type ConsumptionContext = {
  providerContextIdentity: string;
  shopifyPlanHandle: string;
  billingPeriodId: string;
};

function deriveCurrentConsumptionContext(
  subscription: {
    status: string;
    providerSubscriptionId: string | null;
    observedShopifyPlanHandle: string | null;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    billingPeriodId: string | null;
    plan: { active: boolean } | null;
  } | null,
): ConsumptionContext | null {
  if (!subscription || subscription.status !== "ACTIVE" || !subscription.plan?.active) return null;

  const planHandle = subscription.observedShopifyPlanHandle?.trim() ?? "";
  const billingPeriodId = subscription.billingPeriodId?.trim() ?? "";
  if (!planHandle || !billingPeriodId || !isValidCurrentPeriod(subscription.currentPeriodStart, subscription.currentPeriodEnd)) {
    return null;
  }

  try {
    return {
      providerContextIdentity: deriveShopifyProviderContextIdentity({
        providerSubscriptionId: subscription.providerSubscriptionId,
        planHandle,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
      }),
      shopifyPlanHandle: planHandle,
      billingPeriodId,
    };
  } catch {
    return null;
  }
}

function isValidCurrentPeriod(start: Date | null, end: Date | null): boolean {
  return start !== null
    && end !== null
    && Number.isFinite(start.getTime())
    && Number.isFinite(end.getTime())
    && start < end;
}

function spendableLotQuantity(lot: NonNullable<PurchaseLot>): number {
  return lot.currentAmount - lot.reservedAmount;
}

function replayOutcome(reservation: UsageReservation, counter: ReservationCounter): PurchasedReservationOutcome {
  return { kind: recoveryReservationReplayKind(reservation.status), reservation, counter };
}



export const purchasedRecoveryReservationService = new PurchasedRecoveryReservationService();
