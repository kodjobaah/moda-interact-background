import { Prisma, UsageReservationStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RECOVERY_RESERVATION_TRANSACTION_RETRIES,
  RecoveryReservationConcurrencyConflict,
  assertRecoveryReservationShop,
  isRecoveryReservationRetryableConflict,
  isRecoveryReservationUniqueConflict,
  recoveryReservationReplayKind,
  recoveryReservationTransitionDecision,
  validateRecoveryReservationQuantity,
  withRecoveryReservationRetry,
} from "../../../../src/services/recovery-reservation/reservation-lifecycle.js";

class ReservationTestError extends Error {}

const createError = (message: string) => new ReservationTestError(message);

function prismaConflict(code: "P2002" | "P2034") {
  return new Prisma.PrismaClientKnownRequestError("conflict", {
    code,
    clientVersion: "test",
  });
}

describe("recovery reservation lifecycle primitives", () => {
  it("uses one default transaction retry count", () => {
    expect(DEFAULT_RECOVERY_RESERVATION_TRANSACTION_RETRIES).toBe(3);
  });

  it("defaults reservation quantity to one and rejects invalid quantities", () => {
    expect(validateRecoveryReservationQuantity(undefined, createError)).toBe(1);
    expect(validateRecoveryReservationQuantity(2, createError)).toBe(2);
    expect(() => validateRecoveryReservationQuantity(0, createError)).toThrow(
      "Reservation quantity must be a positive safe integer",
    );
    expect(() => validateRecoveryReservationQuantity(1.5, createError)).toThrow(
      ReservationTestError,
    );
  });

  it("enforces reservation shop ownership using the caller error type", () => {
    expect(() => assertRecoveryReservationShop({ shopId: "shop-1" }, "shop-1", createError)).not.toThrow();
    expect(() => assertRecoveryReservationShop({ shopId: "shop-2" }, "shop-1", createError)).toThrow(
      "Reservation belongs to another shop",
    );
  });

  it.each([
    [UsageReservationStatus.RESERVED, "already-reserved"],
    [UsageReservationStatus.COMMITTED, "already-committed"],
    [UsageReservationStatus.RELEASED, "already-released"],
    [UsageReservationStatus.AMBIGUOUS, "already-ambiguous"],
  ] as const)("maps %s to %s", (status, expected) => {
    expect(recoveryReservationReplayKind(status)).toBe(expected);
  });

  it("reactivates only RELEASED reservations and preserves replay status otherwise", () => {
    expect(recoveryReservationTransitionDecision({
      reservation: { status: UsageReservationStatus.RELEASED, quantity: 2 },
      transition: "reactivate",
      requestedQuantity: 2,
      createError,
    })).toEqual({ kind: "apply" });

    expect(recoveryReservationTransitionDecision({
      reservation: { status: UsageReservationStatus.COMMITTED, quantity: 2 },
      transition: "reactivate",
      requestedQuantity: 2,
      createError,
    })).toEqual({ kind: "replay", replayKind: "already-committed" });
  });

  it("requires matching quantity for reactivation, commit and release", () => {
    for (const transition of ["reactivate", "commit", "release"] as const) {
      const status = transition === "reactivate"
        ? UsageReservationStatus.RELEASED
        : UsageReservationStatus.RESERVED;
      expect(() => recoveryReservationTransitionDecision({
        reservation: { status, quantity: 1 },
        transition,
        requestedQuantity: 2,
        createError,
      })).toThrow("Reservation quantity does not match the requested transition");
    }
  });

  it("commits only RESERVED reservations and replays terminal states", () => {
    expect(recoveryReservationTransitionDecision({
      reservation: { status: UsageReservationStatus.RESERVED, quantity: 1 },
      transition: "commit",
      requestedQuantity: 1,
      createError,
    })).toEqual({ kind: "apply" });

    expect(recoveryReservationTransitionDecision({
      reservation: { status: UsageReservationStatus.AMBIGUOUS, quantity: 1 },
      transition: "commit",
      requestedQuantity: 1,
      createError,
    })).toEqual({ kind: "replay", replayKind: "already-ambiguous" });
  });

  it("rejects release of COMMITTED reservations and replays other non-reserved states", () => {
    expect(() => recoveryReservationTransitionDecision({
      reservation: { status: UsageReservationStatus.COMMITTED, quantity: 1 },
      transition: "release",
      requestedQuantity: 1,
      createError,
    })).toThrow("Committed reservations cannot be released");

    expect(recoveryReservationTransitionDecision({
      reservation: { status: UsageReservationStatus.RELEASED, quantity: 1 },
      transition: "release",
      requestedQuantity: 1,
      createError,
    })).toEqual({ kind: "replay", replayKind: "already-released" });
  });

  it("marks only RESERVED reservations ambiguous without rechecking requested quantity", () => {
    expect(recoveryReservationTransitionDecision({
      reservation: { status: UsageReservationStatus.RESERVED, quantity: 7 },
      transition: "ambiguous",
      createError,
    })).toEqual({ kind: "apply" });

    expect(recoveryReservationTransitionDecision({
      reservation: { status: UsageReservationStatus.RELEASED, quantity: 7 },
      transition: "ambiguous",
      createError,
    })).toEqual({ kind: "replay", replayKind: "already-released" });
  });

  it("classifies unique and retryable Prisma conflicts consistently", () => {
    const unique = prismaConflict("P2002");
    const serialization = prismaConflict("P2034");

    expect(isRecoveryReservationUniqueConflict(unique)).toBe(true);
    expect(isRecoveryReservationUniqueConflict(serialization)).toBe(false);
    expect(isRecoveryReservationRetryableConflict(unique)).toBe(true);
    expect(isRecoveryReservationRetryableConflict(serialization)).toBe(true);
    expect(isRecoveryReservationRetryableConflict(new RecoveryReservationConcurrencyConflict())).toBe(true);
    expect(isRecoveryReservationRetryableConflict(new Error("no"))).toBe(false);
  });

  it("retries shared reservation concurrency conflicts and returns the winning result", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new RecoveryReservationConcurrencyConflict())
      .mockResolvedValueOnce("reserved");

    await expect(withRecoveryReservationRetry({
      operation,
      maxRetries: 3,
      createRetryLimitError: createError,
    })).resolves.toBe("reserved");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("stops at the configured retry limit and preserves the last conflict", async () => {
    const conflict = prismaConflict("P2034");
    const operation = vi.fn().mockRejectedValue(conflict);

    await expect(withRecoveryReservationRetry({
      operation,
      maxRetries: 2,
      createRetryLimitError: createError,
    })).rejects.toBe(conflict);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-conflict failures", async () => {
    const failure = new Error("provider state invalid");
    const operation = vi.fn().mockRejectedValue(failure);

    await expect(withRecoveryReservationRetry({
      operation,
      maxRetries: 3,
      createRetryLimitError: createError,
    })).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("preserves the caller-specific retry-limit error when retries are disabled", async () => {
    await expect(withRecoveryReservationRetry({
      operation: vi.fn(),
      maxRetries: 0,
      createRetryLimitError: createError,
    })).rejects.toThrow("Reservation retry limit exceeded");
  });
});
