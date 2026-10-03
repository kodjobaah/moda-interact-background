import { describe, expect, it } from "vitest";

import {
  FREE_CYCLE_DISCOVERY_RETRY_MS,
  nextSubscriptionReconcileAt,
  ROLLOVER_RETRY_MS,
} from "../../../../src/services/billing-subscription-reconciliation/reconciliation-timing.js";

const now = new Date("2026-10-03T12:00:00.000Z");

describe("reconciliation timing", () => {
  it("exports the unchanged fixed retry intervals", () => {
    expect(FREE_CYCLE_DISCOVERY_RETRY_MS).toBe(5 * 60 * 1000);
    expect(ROLLOVER_RETRY_MS).toBe(60 * 1000);
  });

  it.each([
    [9 * 60 * 1000, 60 * 1000],
    [10 * 60 * 1000, 5 * 60 * 1000],
    [60 * 60 * 1000, 30 * 60 * 1000],
    [24 * 60 * 60 * 1000 - 1, 30 * 60 * 1000],
  ])("uses the correct retry tier at age %i ms", (ageMs, delayMs) => {
    const pendingEffectiveAt = new Date(now.getTime() - ageMs);

    expect(nextSubscriptionReconcileAt(pendingEffectiveAt, now))
      .toEqual(new Date(now.getTime() + delayMs));
  });

  it("stops retrying at the 24-hour expiry", () => {
    const pendingEffectiveAt = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    expect(nextSubscriptionReconcileAt(pendingEffectiveAt, now)).toBeNull();
  });
});