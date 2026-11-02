export function resolveEligibleAt({
  pendingAiNotBeforeAt,
  lastInboundAt,
  pendingTurnStartedAt,
  quietMs,
  maxMs,
}: {
  pendingAiNotBeforeAt: Date | null;
  lastInboundAt: Date;
  pendingTurnStartedAt: Date;
  quietMs: number;
  maxMs: number;
}): number {
  const deadline = pendingAiNotBeforeAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const quietDeadline = lastInboundAt.getTime() + quietMs;
  const maximumDeadline = pendingTurnStartedAt.getTime() + maxMs;
  return Math.max(deadline, Math.min(quietDeadline, maximumDeadline));
}