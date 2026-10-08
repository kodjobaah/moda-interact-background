import { Prisma, UsageReservationStatus } from "@prisma/client";
import type { UsageReservation } from "@prisma/client";

export const DEFAULT_RECOVERY_RESERVATION_TRANSACTION_RETRIES = 3;

export type RecoveryReservationReplayKind =
  | "already-reserved"
  | "already-committed"
  | "already-released"
  | "already-ambiguous";

export class RecoveryReservationConcurrencyConflict extends Error {}

type ReservationErrorFactory = (message: string) => Error;

export function validateRecoveryReservationQuantity(
  quantity: number | undefined,
  createError: ReservationErrorFactory,
): number {
  const value = quantity ?? 1;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw createError("Reservation quantity must be a positive safe integer");
  }
  return value;
}

export function assertRecoveryReservationShop(
  reservation: Pick<UsageReservation, "shopId">,
  shopId: string,
  createError: ReservationErrorFactory,
): void {
  if (reservation.shopId !== shopId) {
    throw createError("Reservation belongs to another shop");
  }
}

export function recoveryReservationReplayKind(
  status: UsageReservationStatus,
): RecoveryReservationReplayKind {
  switch (status) {
    case UsageReservationStatus.RESERVED:
      return "already-reserved";
    case UsageReservationStatus.COMMITTED:
      return "already-committed";
    case UsageReservationStatus.RELEASED:
      return "already-released";
    case UsageReservationStatus.AMBIGUOUS:
      return "already-ambiguous";
  }
}

export type RecoveryReservationTransition = "reactivate" | "commit" | "release" | "ambiguous";

export type RecoveryReservationTransitionDecision =
  | { kind: "apply" }
  | { kind: "replay"; replayKind: RecoveryReservationReplayKind };

type RecoveryReservationTransitionInput =
  | {
      reservation: Pick<UsageReservation, "status" | "quantity">;
      transition: "reactivate" | "commit" | "release";
      requestedQuantity: number;
      createError: ReservationErrorFactory;
    }
  | {
      reservation: Pick<UsageReservation, "status" | "quantity">;
      transition: "ambiguous";
      createError: ReservationErrorFactory;
    };

export function recoveryReservationTransitionDecision(
  input: RecoveryReservationTransitionInput,
): RecoveryReservationTransitionDecision {
  const { reservation, transition, createError } = input;

  if (transition === "release" && reservation.status === UsageReservationStatus.COMMITTED) {
    throw createError("Committed reservations cannot be released");
  }

  const requiredStatus = transition === "reactivate"
    ? UsageReservationStatus.RELEASED
    : UsageReservationStatus.RESERVED;

  if (reservation.status !== requiredStatus) {
    return { kind: "replay", replayKind: recoveryReservationReplayKind(reservation.status) };
  }

  if (transition !== "ambiguous" && reservation.quantity !== input.requestedQuantity) {
    throw createError("Reservation quantity does not match the requested transition");
  }

  return { kind: "apply" };
}

export function isRecoveryReservationUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function isRecoveryReservationRetryableConflict(error: unknown): boolean {
  return error instanceof RecoveryReservationConcurrencyConflict ||
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2002" || error.code === "P2034"));
}

export async function withRecoveryReservationRetry<T>(input: {
  operation: () => Promise<T>;
  maxRetries: number;
  createRetryLimitError: ReservationErrorFactory;
}): Promise<T> {
  for (let attempt = 0; attempt < input.maxRetries; attempt += 1) {
    try {
      return await input.operation();
    } catch (error) {
      if (!isRecoveryReservationRetryableConflict(error) || attempt === input.maxRetries - 1) {
        throw error;
      }
    }
  }
  throw input.createRetryLimitError("Reservation retry limit exceeded");
}
