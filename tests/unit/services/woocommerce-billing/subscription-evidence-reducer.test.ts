import { describe, expect, it } from "vitest";

import { reduceFinancialEvidence, type FinancialEvidence } from "../../../../src/services/woocommerce-billing/subscription-evidence-reducer.js";

const evidence = (
  health: FinancialEvidence["health"],
  providerAt: string,
  coverageEndAt: string | null,
): FinancialEvidence => ({
  health,
  providerAt: new Date(providerAt),
  coverageEndAt: coverageEndAt ? new Date(coverageEndAt) : null,
});

describe("reduceFinancialEvidence", () => {
  it("uses the newest provider timestamp, independent of receipt delivery order", () => {
    const renewed = evidence("ACTIVE", "2026-10-08T10:00:00.000Z", "2026-11-08T10:00:00.000Z");
    const paused = evidence("PAUSED", "2026-10-07T10:00:00.000Z", null);

    expect(reduceFinancialEvidence([paused, renewed])).toEqual({ kind: "resolved", evidence: renewed });
    expect(reduceFinancialEvidence([renewed, paused])).toEqual({ kind: "resolved", evidence: renewed });
  });

  it("allows authoritative coverage to move earlier", () => {
    const prior = evidence("ACTIVE", "2026-10-07T10:00:00.000Z", "2026-11-08T10:00:00.000Z");
    const current = evidence("ACTIVE", "2026-10-08T10:00:00.000Z", "2026-10-20T10:00:00.000Z");

    expect(reduceFinancialEvidence([prior, current])).toEqual({ kind: "resolved", evidence: current });
  });

  it("fails closed when equally current authenticated observations disagree", () => {
    const renewed = evidence("ACTIVE", "2026-10-08T10:00:00.000Z", "2026-11-08T10:00:00.000Z");
    const paused = evidence("PAUSED", "2026-10-08T10:00:00.000Z", null);

    expect(reduceFinancialEvidence([renewed, paused])).toEqual({
      kind: "conflict",
      reason: "CONTRADICTORY_FINANCIAL_EVIDENCE",
    });
  });
});