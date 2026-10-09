import { describe, expect, it } from "vitest";

import { resolvePlanIntent, type RecurringIntent } from "../../../../src/services/woocommerce-billing/subscription-operation-resolution.js";

const create = (
  id: string,
  kind: RecurringIntent["kind"],
  createdAt: string,
  price = 1999,
): RecurringIntent => ({
  id,
  kind,
  state: "AWAITING_CONFIRMATION",
  createdAt: new Date(createdAt),
  merchantPricingPlanId: `plan-${id}`,
  quotedAmountMinor: price,
});

describe("resolvePlanIntent", () => {
  it("lets serialized merchant intent supersede an earlier switch regardless of input order", () => {
    const earlier = create("switch-a", "PLAN_SWITCH", "2026-10-07T10:00:00.000Z");
    const current = create("switch-b", "PLAN_SWITCH", "2026-10-08T10:00:00.000Z", 2999);

    expect(resolvePlanIntent([current, earlier], new Date("2026-10-08T11:00:00.000Z"), 2999)).toEqual({
      kind: "resolved",
      operation: current,
    });
  });

  it("does not apply a late-arriving snapshot whose provider time predates the current intent", () => {
    const current = create("switch-b", "PLAN_SWITCH", "2026-10-08T10:00:00.000Z", 2999);

    expect(resolvePlanIntent([current], new Date("2026-10-07T10:00:00.000Z"), 1999)).toEqual({ kind: "stale" });
  });

  it("compares merchant intent with the signed snapshot time, not an older payment timestamp", () => {
    const current = create("switch-b", "PLAN_SWITCH", "2026-10-08T10:00:00.000Z", 2999);

    expect(resolvePlanIntent([current], new Date("2026-10-08T10:05:00.000Z"), 2999)).toEqual({
      kind: "resolved",
      operation: current,
    });
  });

  it("fails closed when an updated snapshot has no provider timestamp", () => {
    const current = create("switch-b", "PLAN_SWITCH", "2026-10-08T10:00:00.000Z", 2999);

    expect(resolvePlanIntent([current], null, 2999)).toEqual({
      kind: "conflict",
      reason: "PROVIDER_SNAPSHOT_TIME_MISSING",
    });
  });

  it("fails closed for tied merchant intents or incompatible provider plan price", () => {
    const first = create("switch-a", "PLAN_SWITCH", "2026-10-08T10:00:00.000Z");
    const second = create("switch-b", "PLAN_SWITCH", "2026-10-08T10:00:00.000Z", 2999);

    expect(resolvePlanIntent([first, second], new Date("2026-10-08T11:00:00.000Z"), 2999)).toEqual({
      kind: "conflict",
      reason: "AMBIGUOUS_PLAN_INTENT",
    });
    expect(resolvePlanIntent([first], new Date("2026-10-08T11:00:00.000Z"), 2999)).toEqual({
      kind: "conflict",
      reason: "PROVIDER_PLAN_MISMATCH",
    });
  });
});