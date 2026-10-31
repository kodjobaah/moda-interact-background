import { describe, expect, it, vi } from "vitest";
import {
  CheckoutRecoveryLifetimePolicyUnavailableError,
  isCheckoutRecoveryWithinLifetime,
  parseCheckoutRecoveryLifetimeDays,
  PersistedCheckoutRecoveryLifetimeReader,
} from "../../../../src/services/recovery-lifetime/checkout-recovery-lifetime.js";

const now = new Date("2026-10-31T12:00:00.000Z");
const millisecondsPerDay = 86_400_000;

describe("checkout recovery lifetime", () => {
  it.each([0, 1, 21, 91, 180, 365, 2_147_483_647])(
    "parses PostgreSQL-compatible lifetime %i without an application cap",
    (days) => expect(parseCheckoutRecoveryLifetimeDays(days)).toBe(days),
  );

  it("keeps PostgreSQL's maximum lifetime exact across the valid Date range", () => {
    expect(isCheckoutRecoveryWithinLifetime({
      lastExternalActivityAt: new Date(-8_640_000_000_000_000),
      now: new Date(8_640_000_000_000_000),
      checkoutRecoveryLifetimeDays: 2_147_483_647,
    })).toBe(true);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "21", null, undefined])(
    "rejects malformed lifetime %s",
    (days) => expect(() => parseCheckoutRecoveryLifetimeDays(days)).toThrow(RangeError),
  );

  it.each([0, 1, 21, 91, 180, 365])(
    "uses a strict exact cutoff for %i days",
    (days) => {
      const lifetimeMs = days * millisecondsPerDay;
      const exactCutoff = new Date(now.getTime() - lifetimeMs);
      expect(isCheckoutRecoveryWithinLifetime({ lastExternalActivityAt: exactCutoff,
        now, checkoutRecoveryLifetimeDays: days })).toBe(false);
      if (days > 0) {
        expect(isCheckoutRecoveryWithinLifetime({ lastExternalActivityAt: new Date(exactCutoff.getTime() + 1),
          now, checkoutRecoveryLifetimeDays: days })).toBe(true);
      }
    },
  );

  it("rejects future and invalid timestamps, and makes zero days immediately ineligible", () => {
    expect(isCheckoutRecoveryWithinLifetime({ lastExternalActivityAt: now, now,
      checkoutRecoveryLifetimeDays: 0 })).toBe(false);
    expect(isCheckoutRecoveryWithinLifetime({ lastExternalActivityAt: new Date(now.getTime() + 1), now,
      checkoutRecoveryLifetimeDays: 21 })).toBe(false);
    expect(isCheckoutRecoveryWithinLifetime({ lastExternalActivityAt: new Date(Number.NaN), now,
      checkoutRecoveryLifetimeDays: 21 })).toBe(false);
    expect(isCheckoutRecoveryWithinLifetime({ lastExternalActivityAt: now, now: new Date(Number.NaN),
      checkoutRecoveryLifetimeDays: 21 })).toBe(false);
    expect(isCheckoutRecoveryWithinLifetime({ lastExternalActivityAt: now, now,
      checkoutRecoveryLifetimeDays: -1 })).toBe(false);
  });

  it("reads only the persisted default policy and validates missing or invalid values", async () => {
    const findUnique = vi.fn().mockResolvedValue({ checkoutRecoveryLifetimeDays: 91 });
    const reader = new PersistedCheckoutRecoveryLifetimeReader({ backgroundRuntimeConfig: { findUnique } } as never);
    await expect(reader.read()).resolves.toBe(91);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "default" },
      select: { checkoutRecoveryLifetimeDays: true } });

    findUnique.mockResolvedValueOnce(null);
    await expect(reader.read()).rejects.toMatchObject({
      name: "CheckoutRecoveryLifetimePolicyUnavailableError", reason: "missing",
    } satisfies Partial<CheckoutRecoveryLifetimePolicyUnavailableError>);
    findUnique.mockResolvedValueOnce({ checkoutRecoveryLifetimeDays: 1.25 });
    await expect(reader.read()).rejects.toMatchObject({
      name: "CheckoutRecoveryLifetimePolicyUnavailableError", reason: "invalid",
    });
  });

  it("propagates unexpected persisted-policy read errors", async () => {
    const failure = new Error("database unavailable");
    const reader = new PersistedCheckoutRecoveryLifetimeReader({
      backgroundRuntimeConfig: { findUnique: vi.fn().mockRejectedValue(failure) },
    } as never);
    await expect(reader.read()).rejects.toBe(failure);
  });
});