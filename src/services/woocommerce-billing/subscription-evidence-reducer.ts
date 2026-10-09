export type FinancialEvidence = {
  health: "ACTIVE" | "PAUSED";
  providerAt: Date;
  coverageEndAt: Date | null;
};

export type FinancialEvidenceReduction =
  | { kind: "none" }
  | { kind: "resolved"; evidence: FinancialEvidence }
  | { kind: "conflict"; reason: "CONTRADICTORY_FINANCIAL_EVIDENCE" };

export function reduceFinancialEvidence(
  observations: readonly FinancialEvidence[],
): FinancialEvidenceReduction {
  if (observations.length === 0) return { kind: "none" };

  const latestAt = Math.max(...observations.map(({ providerAt }) => providerAt.getTime()));
  const latest = observations.filter(({ providerAt }) => providerAt.getTime() === latestAt);
  const first = latest[0];
  if (!first || !Number.isFinite(latestAt)) {
    return { kind: "conflict", reason: "CONTRADICTORY_FINANCIAL_EVIDENCE" };
  }

  const agrees = latest.every((evidence) =>
    evidence.health === first.health
    && evidence.coverageEndAt?.getTime() === first.coverageEndAt?.getTime());
  return agrees
    ? { kind: "resolved", evidence: first }
    : { kind: "conflict", reason: "CONTRADICTORY_FINANCIAL_EVIDENCE" };
}