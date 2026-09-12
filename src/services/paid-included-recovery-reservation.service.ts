import {
  BillingPeriodStatus,
  BillingPlanKind,
  BillingPeriodEntitlementCounterKind,
  Prisma,
  ShopifyReportState,
  UsageMetric,
  UsageReservationStatus,
} from "@prisma/client";
import type { PrismaClient, UsageReservation } from "@prisma/client";
import {
  createRecoveryIdempotencyKey,
  createShopifyUsageIdempotencyKey,
} from "@modainteract/moda-interact-shared/billing";

import prisma from "../lib/db.js";
import {
  EffectiveBillingPolicyResolver,
  type BillingPolicyClient,
  type EffectiveBillingPolicy,
} from "./effective-billing-policy.service.js";

const MAX_TRANSACTION_RETRIES = 3;

export type PaidIncludedRecoveryReservationInput = {
  shopId: string;
  recoveryId?: string;
  sourceKey?: string;
  quantity?: number;
};

type ReservationCounter = "INCLUDED_RECOVERY_CREDITS";

type ReservationReplay = {
  kind:
    | "already-reserved"
    | "already-committed"
    | "already-released"
    | "already-ambiguous";
  reservation: UsageReservation;
  counter: ReservationCounter;
  sourceKey: string;
  policy?: EffectiveBillingPolicy | undefined;
};

export type PaidIncludedReservationOutcome =
  | {
      kind: "reserved";
      reservation: UsageReservation;
      counter: ReservationCounter;
      sourceKey: string;
      policy: EffectiveBillingPolicy;
    }
  | { kind: "committed"; reservation: UsageReservation }
  | { kind: "released"; reservation: UsageReservation }
  | { kind: "ambiguous"; reservation: UsageReservation }
  | ReservationReplay
  | { kind: "allowance-exhausted"; remaining: number; policy: EffectiveBillingPolicy };

export class PaidIncludedRecoveryReservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaidIncludedRecoveryReservationError";
  }
}

class ReservationConcurrencyConflict extends Error {}
type ReservationTransaction = Prisma.TransactionClient;
type ReservationDatabase = Pick<
  PrismaClient,
  "$transaction" | "subscription" | "usageReservation" | "usageEvent"
>;
type PolicyResolverFactory = (
  client: BillingPolicyClient,
) => Pick<EffectiveBillingPolicyResolver, "resolve">;

type CurrentPeriod = {
  id: string;
  shopId: string;
  subscriptionId: string;
  periodStart: Date;
  periodEnd: Date;
  status: BillingPeriodStatus;
};

export class PaidIncludedRecoveryReservationService {
  constructor(
    private readonly database: ReservationDatabase = prisma,
    private readonly maxRetries = MAX_TRANSACTION_RETRIES,
    private readonly now: () => Date = () => new Date(),
    private readonly createPolicyResolver: PolicyResolverFactory = (client) =>
      new EffectiveBillingPolicyResolver(client),
  ) {}

  async reserve(
    input: Required<Pick<PaidIncludedRecoveryReservationInput, "shopId" | "recoveryId">> &
      Pick<PaidIncludedRecoveryReservationInput, "quantity">,
  ): Promise<PaidIncludedReservationOutcome> {
    const quantity = validateQuantity(input.quantity);
    return this.withRetry(() =>
      this.database.$transaction(
        (transaction) => this.reserveInTransaction(transaction, input, quantity),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async commit(
    input: Required<Pick<PaidIncludedRecoveryReservationInput, "shopId" | "sourceKey">> &
      Pick<PaidIncludedRecoveryReservationInput, "quantity"> & { occurredAt?: Date },
  ): Promise<PaidIncludedReservationOutcome> {
    const quantity = validateQuantity(input.quantity);
    return this.withRetry(() =>
      this.database.$transaction(
        (transaction) => this.commitInTransaction(transaction, input, quantity),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async release(
    input: Required<Pick<PaidIncludedRecoveryReservationInput, "shopId" | "sourceKey">> &
      Pick<PaidIncludedRecoveryReservationInput, "quantity">,
  ): Promise<PaidIncludedReservationOutcome> {
    const quantity = validateQuantity(input.quantity);
    return this.withRetry(() =>
      this.database.$transaction(
        (transaction) => this.releaseInTransaction(transaction, input, quantity),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async markAmbiguous(
    input: Required<Pick<PaidIncludedRecoveryReservationInput, "shopId" | "sourceKey">> &
      Pick<PaidIncludedRecoveryReservationInput, "quantity">,
  ): Promise<PaidIncludedReservationOutcome> {
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
    input: Required<Pick<PaidIncludedRecoveryReservationInput, "shopId" | "recoveryId">>,
    quantity: number,
  ): Promise<PaidIncludedReservationOutcome> {
    const policyResolver = this.createPolicyResolver(transaction);
    const policy = await policyResolver.resolve(input.shopId, this.now());
    if (policy.planKind !== BillingPlanKind.PAID_METERED) {
      throw new PaidIncludedRecoveryReservationError("Paid included reservation requires a paid plan");
    }
    const period = await this.requireCurrentOpenPeriod(transaction, input.shopId, policy, this.now());
    const sourceKey = `paid-included:${period.id}:${input.recoveryId}`;
    const existing = await transaction.usageReservation.findUnique({ where: { sourceKey } });

    if (existing) {
      assertReservationShop(existing, input.shopId);
      const periodCounter = await this.requireCounter(transaction, period);
      if (existing.billingPeriodEntitlementCounterId !== periodCounter.id) {
        throw new PaidIncludedRecoveryReservationError("Reservation belongs to another billing period counter");
      }
      const counter = await this.readCounter(transaction, existing);
      if (existing.status === UsageReservationStatus.RELEASED) {
        if (existing.quantity !== quantity) {
          throw new PaidIncludedRecoveryReservationError("Reservation quantity does not match the requested transition");
        }
        const available = availableQuantity(periodCounter);
        if (available < quantity) return replayOutcome(existing, sourceKey, counter);
        const updatedCounter = await transaction.billingPeriodEntitlementCounter.updateMany({
          where: { id: periodCounter.id, version: periodCounter.version },
          data: { reservedQuantity: { increment: quantity }, version: { increment: 1 } },
        });
        if (updatedCounter.count !== 1) throw new ReservationConcurrencyConflict();
        const reactivated = await transaction.usageReservation.update({
          where: { id: existing.id },
          data: { status: UsageReservationStatus.RESERVED, releaseReason: null },
        });
        return { kind: "reserved", reservation: reactivated, counter, sourceKey, policy };
      }
      return replayOutcome(existing, sourceKey, counter, policy);
    }

    const periodCounter = await this.requireCounter(transaction, period);
    const available = availableQuantity(periodCounter);
    if (available < quantity) return { kind: "allowance-exhausted", remaining: available, policy };

    const updatedCounter = await transaction.billingPeriodEntitlementCounter.updateMany({
      where: { id: periodCounter.id, version: periodCounter.version },
      data: { reservedQuantity: { increment: quantity }, version: { increment: 1 } },
    });
    if (updatedCounter.count !== 1) throw new ReservationConcurrencyConflict();

    const reservation = await transaction.usageReservation.create({
      data: {
        shopId: input.shopId,
        sourceKey,
        quantity,
        counterId: null,
        promotionalCreditGrantId: null,
        purchasedCreditPurchaseId: null,
        billingPeriodEntitlementCounterId: periodCounter.id,
      },
    });
    return {
      kind: "reserved",
      reservation,
      counter: "INCLUDED_RECOVERY_CREDITS",
      sourceKey,
      policy,
    };
  }

  private async commitInTransaction(
    transaction: ReservationTransaction,
    input: Required<Pick<PaidIncludedRecoveryReservationInput, "shopId" | "sourceKey">> & { occurredAt?: Date },
    quantity: number,
  ): Promise<PaidIncludedReservationOutcome> {
    const reservation = await this.requireReservation(transaction, input);
    if (reservation.status !== UsageReservationStatus.RESERVED) {
      return replayOutcome(reservation, input.sourceKey, "INCLUDED_RECOVERY_CREDITS");
    }
    if (reservation.quantity !== quantity) {
      throw new PaidIncludedRecoveryReservationError("Reservation quantity does not match the requested transition");
    }
    if (!reservation.billingPeriodEntitlementCounterId || reservation.counterId || reservation.purchasedCreditPurchaseId) {
      throw new PaidIncludedRecoveryReservationError("Reservation is not a paid included reservation");
    }

    const now = this.now();
    const subscription = await transaction.subscription.findUnique({
      where: { shopId: input.shopId },
      select: { id: true, billingPeriodId: true, currentPeriodStart: true, currentPeriodEnd: true },
    });
    const counter = await transaction.billingPeriodEntitlementCounter.findUnique({
      where: { id: reservation.billingPeriodEntitlementCounterId },
      include: { billingPeriod: true },
    });
    if (!subscription || !counter || counter.counter !== BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS) {
      throw new PaidIncludedRecoveryReservationError("Paid included reservation counter does not exist");
    }
    const period = counter.billingPeriod;
    if (
      period.status !== BillingPeriodStatus.OPEN ||
      period.periodEnd <= now ||
      subscription.billingPeriodId !== period.id ||
      period.shopId !== input.shopId ||
      period.subscriptionId !== subscription.id ||
      counter.shopId !== input.shopId ||
      counter.billingPeriodId !== period.id ||
      subscription.currentPeriodStart?.getTime() !== period.periodStart.getTime() ||
      subscription.currentPeriodEnd?.getTime() !== period.periodEnd.getTime()
    ) {
      throw new PaidIncludedRecoveryReservationError("Paid included reservation period is no longer current and open");
    }

    const plan = await transaction.subscription.findUnique({
      where: { shopId: input.shopId },
      select: { plan: { select: { kind: true, shopifyUsageEventHandle: true } } },
    });
    if (plan?.plan?.kind !== BillingPlanKind.PAID_METERED || !plan.plan.shopifyUsageEventHandle) {
      throw new PaidIncludedRecoveryReservationError("Paid normal usage meter is missing");
    }

    const updatedCounter = await transaction.billingPeriodEntitlementCounter.updateMany({
      where: {
        id: counter.id,
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

    const idempotencyKey = createRecoveryIdempotencyKey(input.shopId, input.sourceKey);
    const usageEvent = await transaction.usageEvent.create({
      data: {
        shopId: input.shopId,
        billingPeriodId: period.id,
        metric: UsageMetric.RECOVERY_CONVERSATION,
        quantity,
        idempotencyKey,
        sourceType: "PAID_RECOVERY_CONVERSATION",
        sourceId: input.sourceKey,
        occurredAt: input.occurredAt ?? now,
        shopifyReportState: ShopifyReportState.PENDING,
        shopifyEventHandle: await this.readPaidUsageEventHandle(transaction, input.shopId),
        shopifyIdempotencyKey: createShopifyUsageIdempotencyKey(input.shopId, idempotencyKey),
      },
    });
    const committed = await transaction.usageReservation.update({
      where: { id: reservation.id },
      data: { status: UsageReservationStatus.COMMITTED, committedUsageEventId: usageEvent.id },
    });
    return { kind: "committed", reservation: committed };
  }

  private async releaseInTransaction(
    transaction: ReservationTransaction,
    input: Required<Pick<PaidIncludedRecoveryReservationInput, "shopId" | "sourceKey">>,
    quantity: number,
  ): Promise<PaidIncludedReservationOutcome> {
    const reservation = await this.requireReservation(transaction, input);
    if (reservation.status === UsageReservationStatus.COMMITTED) {
      throw new PaidIncludedRecoveryReservationError("Committed reservations cannot be released");
    }
    if (reservation.status !== UsageReservationStatus.RESERVED) {
      return replayOutcome(reservation, input.sourceKey, "INCLUDED_RECOVERY_CREDITS");
    }
    if (reservation.quantity !== quantity) {
      throw new PaidIncludedRecoveryReservationError("Reservation quantity does not match the requested transition");
    }
    const counter = await this.requireOpenReservationCounter(transaction, reservation, input.shopId);
    const updatedCounter = await transaction.billingPeriodEntitlementCounter.updateMany({
      where: { id: counter.id, version: counter.version, reservedQuantity: { gte: quantity } },
      data: { reservedQuantity: { decrement: quantity }, version: { increment: 1 } },
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
    input: Required<Pick<PaidIncludedRecoveryReservationInput, "shopId" | "sourceKey">>,
  ): Promise<PaidIncludedReservationOutcome> {
    const reservation = await this.requireReservation(transaction, input);
    if (reservation.status !== UsageReservationStatus.RESERVED) {
      return replayOutcome(reservation, input.sourceKey, "INCLUDED_RECOVERY_CREDITS");
    }
    await this.requireOpenReservationCounter(transaction, reservation, input.shopId);
    const ambiguous = await transaction.usageReservation.update({
      where: { id: reservation.id },
      data: { status: UsageReservationStatus.AMBIGUOUS },
    });
    return { kind: "ambiguous", reservation: ambiguous };
  }

  private async requireCurrentOpenPeriod(
    transaction: ReservationTransaction,
    shopId: string,
    policy: EffectiveBillingPolicy,
    now: Date,
  ): Promise<CurrentPeriod> {
    const subscription = await transaction.subscription.findUnique({
      where: { shopId },
      select: {
        id: true,
        billingPeriodId: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        billingPeriod: { select: { id: true, shopId: true, subscriptionId: true, periodStart: true, periodEnd: true, status: true } },
      },
    });
    const period = subscription?.billingPeriod;
    if (
      !subscription ||
      !period ||
      !policy.billingPeriod ||
      policy.shopId !== shopId ||
      policy.subscriptionId !== subscription.id ||
      policy.billingPeriod.id !== period.id ||
      subscription.billingPeriodId !== period.id ||
      period.shopId !== shopId ||
      period.subscriptionId !== subscription.id ||
      period.status !== BillingPeriodStatus.OPEN ||
      period.periodEnd <= now ||
      subscription.currentPeriodStart?.getTime() !== period.periodStart.getTime() ||
      subscription.currentPeriodEnd?.getTime() !== period.periodEnd.getTime()
    ) {
      throw new PaidIncludedRecoveryReservationError("Paid subscription has no exact current open billing period");
    }
    return period;
  }

  private async requireCounter(transaction: ReservationTransaction, period: CurrentPeriod) {
    const counter = await transaction.billingPeriodEntitlementCounter.findUnique({
      where: {
        billingPeriodId_counter: {
          billingPeriodId: period.id,
          counter: BillingPeriodEntitlementCounterKind.INCLUDED_RECOVERY_CREDITS,
        },
      },
    });
    if (!counter || counter.shopId !== period.shopId || counter.billingPeriodId !== period.id) {
      throw new PaidIncludedRecoveryReservationError("Included recovery period counter does not exist");
    }
    validateCounter(counter.grantedQuantity, counter.committedQuantity, counter.reservedQuantity, counter.forfeitedQuantity);
    return counter;
  }

  private async requireOpenReservationCounter(
    transaction: ReservationTransaction,
    reservation: UsageReservation,
    shopId: string,
  ) {
    if (!reservation.billingPeriodEntitlementCounterId) {
      throw new PaidIncludedRecoveryReservationError("Reservation period counter does not exist");
    }
    const counter = await transaction.billingPeriodEntitlementCounter.findUnique({
      where: { id: reservation.billingPeriodEntitlementCounterId },
      include: { billingPeriod: true },
    });
    if (!counter || counter.shopId !== shopId || counter.billingPeriod.status !== BillingPeriodStatus.OPEN || counter.billingPeriod.periodEnd <= this.now()) {
      throw new PaidIncludedRecoveryReservationError("Reservation billing period is closed or expired");
    }
    validateCounter(counter.grantedQuantity, counter.committedQuantity, counter.reservedQuantity, counter.forfeitedQuantity);
    return counter;
  }

  private async readCounter(transaction: ReservationTransaction, reservation: UsageReservation): Promise<ReservationCounter> {
    if (!reservation.billingPeriodEntitlementCounterId || reservation.counterId || reservation.purchasedCreditPurchaseId) {
      throw new PaidIncludedRecoveryReservationError("Reservation is not a paid included reservation");
    }
    return "INCLUDED_RECOVERY_CREDITS";
  }

  private async requireReservation(transaction: ReservationTransaction, input: { shopId: string; sourceKey: string }) {
    const reservation = await transaction.usageReservation.findUnique({ where: { sourceKey: input.sourceKey } });
    if (!reservation) throw new PaidIncludedRecoveryReservationError("Reservation does not exist");
    assertReservationShop(reservation, input.shopId);
    return reservation;
  }

  private async readPaidUsageEventHandle(transaction: ReservationTransaction, shopId: string): Promise<string> {
    const subscription = await transaction.subscription.findUnique({
      where: { shopId },
      select: { plan: { select: { kind: true, shopifyUsageEventHandle: true } } },
    });
    if (subscription?.plan?.kind !== BillingPlanKind.PAID_METERED || !subscription.plan.shopifyUsageEventHandle) {
      throw new PaidIncludedRecoveryReservationError("Paid normal usage meter is missing");
    }
    return subscription.plan.shopifyUsageEventHandle;
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isRetryableConflict(error) || attempt === this.maxRetries - 1) throw error;
      }
    }
    throw new PaidIncludedRecoveryReservationError("Reservation retry limit exceeded");
  }
}

function validateQuantity(quantity: number | undefined): number {
  const value = quantity ?? 1;
  if (!Number.isSafeInteger(value) || value <= 0) throw new PaidIncludedRecoveryReservationError("Reservation quantity must be a positive safe integer");
  return value;
}

function validateCounter(granted: number, committed: number, reserved: number, forfeited: number): void {
  for (const value of [granted, committed, reserved, forfeited]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new PaidIncludedRecoveryReservationError("Included recovery period counter quantities are invalid");
  }
  if (committed + reserved + forfeited > granted) throw new PaidIncludedRecoveryReservationError("Included recovery period counter quantities exceed the grant");
}

function availableQuantity(counter: { grantedQuantity: number; committedQuantity: number; reservedQuantity: number; forfeitedQuantity: number }): number {
  return counter.grantedQuantity - counter.committedQuantity - counter.reservedQuantity - counter.forfeitedQuantity;
}

function replayOutcome(
  reservation: UsageReservation,
  sourceKey: string,
  counter: ReservationCounter,
  policy?: EffectiveBillingPolicy,
): ReservationReplay {
  const kind = {
    [UsageReservationStatus.RESERVED]: "already-reserved",
    [UsageReservationStatus.COMMITTED]: "already-committed",
    [UsageReservationStatus.RELEASED]: "already-released",
    [UsageReservationStatus.AMBIGUOUS]: "already-ambiguous",
  }[reservation.status] as ReservationReplay["kind"];
  return policy === undefined
    ? { kind, reservation, counter, sourceKey }
    : { kind, reservation, counter, sourceKey, policy };
}

function assertReservationShop(reservation: UsageReservation, shopId: string): void {
  if (reservation.shopId !== shopId) throw new PaidIncludedRecoveryReservationError("Reservation belongs to another shop");
}

function isRetryableConflict(error: unknown): boolean {
  return error instanceof ReservationConcurrencyConflict ||
    (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034"));
}

export const paidIncludedRecoveryReservationService = new PaidIncludedRecoveryReservationService();
