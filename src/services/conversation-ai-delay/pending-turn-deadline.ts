export function computePendingAiNotBeforeAt({
  pendingStartedAt,
  delayMinutes,
}: {
  pendingStartedAt: Date;
  delayMinutes: number;
}): Date {
  if (
    !(pendingStartedAt instanceof Date) ||
    !Number.isFinite(pendingStartedAt.getTime())
  ) {
    throw new TypeError("pendingStartedAt must be a valid Date");
  }
  if (!Number.isInteger(delayMinutes) || delayMinutes < 0 || delayMinutes > 30) {
    throw new RangeError("delayMinutes must be an integer from 0 through 30");
  }

  const deadline = new Date(pendingStartedAt.getTime() + 60_000 * delayMinutes);
  if (!Number.isFinite(deadline.getTime())) {
    throw new RangeError("pending AI deadline is outside the supported Date range");
  }
  return deadline;
}