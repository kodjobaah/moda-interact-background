export const RECOVERY_CAPACITY_RESUME_QUEUE = "recovery-capacity-resume";
export const RESUME_CAPACITY_BLOCKED_RECOVERIES_JOB =
  "resume-capacity-blocked-recoveries";

export type RecoveryCapacityResumeJob = {
  shopId: string;
  trigger: string;
};

export function createRecoveryCapacityResumeJobId(input: RecoveryCapacityResumeJob): string {
  return `recovery-capacity-resume--${input.shopId}--${input.trigger}`;
}