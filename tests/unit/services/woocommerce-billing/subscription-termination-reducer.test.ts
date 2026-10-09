import { describe, expect, it } from "vitest";

import { reduceTerminationEvidence, type TerminationEvidence } from "../../../../src/services/woocommerce-billing/subscription-termination-reducer.js";

const evidence = (
  state: TerminationEvidence["state"],
  endAt: string,
  providerAt: string | null,
): TerminationEvidence => ({
  state,
  endAt: new Date(endAt),
  providerAt: providerAt ? new Date(providerAt) : null,
});

describe("reduceTerminationEvidence", () => {
  const now = new Date("2026-10-09T00:00:00.000Z");

  it("keeps cancellation scheduled until signed prepaid coverage ends", () => {
    expect(reduceTerminationEvidence([
      evidence("CANCEL_SCHEDULED", "2026-11-08T10:00:00.000Z", "2026-10-08T10:00:00.000Z"),
    ], now)).toEqual({ kind: "scheduled", endAt: new Date("2026-11-08T10:00:00.000Z") });
  });

  it("converges directly to terminal end when cancellation arrived after its signed end", () => {
    expect(reduceTerminationEvidence([
      evidence("CANCEL_SCHEDULED", "2026-10-08T10:00:00.000Z", "2026-10-07T10:00:00.000Z"),
    ], now)).toEqual({ kind: "ended", endAt: new Date("2026-10-08T10:00:00.000Z") });
  });

  it("accepts a coherent terminal event without a prior canceled observation", () => {
    expect(reduceTerminationEvidence([
      evidence("PREPAID_TERM_ENDED", "2026-10-08T10:00:00.000Z", null),
    ], now)).toEqual({ kind: "ended", endAt: new Date("2026-10-08T10:00:00.000Z") });
  });

  it("accepts one signed cancellation even when Woo omits date_modified", () => {
    expect(reduceTerminationEvidence([
      evidence("CANCEL_SCHEDULED", "2026-11-08T10:00:00.000Z", null),
    ], now)).toEqual({ kind: "scheduled", endAt: new Date("2026-11-08T10:00:00.000Z") });
  });

  it("does not let arrival order select between equally dated conflicting cancellations", () => {
    const first = evidence("CANCEL_SCHEDULED", "2026-11-08T10:00:00.000Z", "2026-10-08T10:00:00.000Z");
    const second = evidence("CANCEL_SCHEDULED", "2026-12-08T10:00:00.000Z", "2026-10-08T10:00:00.000Z");

    expect(reduceTerminationEvidence([first, second], now)).toEqual({
      kind: "conflict",
      reason: "INCOHERENT_TERM_END_EVIDENCE",
    });
  });
});