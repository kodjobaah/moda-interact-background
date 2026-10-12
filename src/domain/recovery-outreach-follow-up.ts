export const RECOVERY_OUTREACH_FOLLOW_UP_QUEUE = "recovery-outreach-follow-up";
export const RECOVERY_OUTREACH_FOLLOW_UP_JOB = "recovery-outreach-follow-up";

export type RecoveryOutreachFollowUpJob = {
  checkoutRecoveryId: string;
  sequence: 2;
};

export function createRecoveryOutreachFollowUpJobId(
  input: RecoveryOutreachFollowUpJob,
  dueAt?: Date,
): string {
  const baseId = `recovery-outreach-follow-up:${input.checkoutRecoveryId}:${input.sequence}`;
  return dueAt ? `${baseId}--${dueAt.getTime()}` : baseId;
}