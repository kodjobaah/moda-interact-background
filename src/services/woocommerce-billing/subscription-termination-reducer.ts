export type TerminationEvidence = {
  state: "CANCEL_SCHEDULED" | "PREPAID_TERM_ENDED";
  endAt: Date;
  providerAt: Date | null;
};

export type TerminationReduction =
  | { kind: "none" }
  | { kind: "scheduled"; endAt: Date }
  | { kind: "ended"; endAt: Date }
  | { kind: "conflict"; reason: "INCOHERENT_TERM_END_EVIDENCE" };

export const WOO_PREPAID_TERM_CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

export function reduceTerminationEvidence(
  observations: readonly TerminationEvidence[],
  now: Date,
): TerminationReduction {
  const terminal = observations.filter(({ state }) => state === "PREPAID_TERM_ENDED");
  const cancellations = observations.filter(({ state }) => state === "CANCEL_SCHEDULED");
  const newestCancellation = newestProviderObservation(cancellations);
  if (newestCancellation.kind === "conflict") {
    return { kind: "conflict", reason: "INCOHERENT_TERM_END_EVIDENCE" };
  }

  const cancellationEndAt = newestCancellation.kind === "resolved"
    ? newestCancellation.evidence.endAt
    : undefined;
  const endedAt = terminal[0]?.endAt ?? cancellationEndAt;
  if (!endedAt) return { kind: "none" };
  if (terminal.some(({ endAt }) => endAt.getTime() !== endedAt.getTime())) {
    return { kind: "conflict", reason: "INCOHERENT_TERM_END_EVIDENCE" };
  }
  if (terminal.length > 0 || endedAt.getTime() <= now.getTime()) {
    return now.getTime() + WOO_PREPAID_TERM_CLOCK_TOLERANCE_MS >= endedAt.getTime()
      ? { kind: "ended", endAt: endedAt }
      : { kind: "conflict", reason: "INCOHERENT_TERM_END_EVIDENCE" };
  }
  return { kind: "scheduled", endAt: endedAt };
}

function newestProviderObservation(
  observations: readonly TerminationEvidence[],
): { kind: "none" } | { kind: "resolved"; evidence: TerminationEvidence } | { kind: "conflict" } {
  if (observations.length === 0) return { kind: "none" };
  const distinctEndTimes = new Set(observations.map(({ endAt }) => endAt.getTime()));
  if (distinctEndTimes.size === 1) return { kind: "resolved", evidence: observations[0]! };
  if (observations.some(({ providerAt }) => providerAt === null)) return { kind: "conflict" };
  const newestAt = Math.max(...observations.map(({ providerAt }) => providerAt!.getTime()));
  const newest = observations.filter(({ providerAt }) => providerAt!.getTime() === newestAt);
  const first = newest[0];
  return first && newest.every(({ endAt }) => endAt.getTime() === first.endAt.getTime())
    ? { kind: "resolved", evidence: first }
    : { kind: "conflict" };
}