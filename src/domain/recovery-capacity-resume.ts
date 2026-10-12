import { createHash } from "node:crypto";

export const RECOVERY_CAPACITY_RESUME_QUEUE = "recovery-capacity-resume";
export const RESUME_CAPACITY_BLOCKED_RECOVERIES_JOB =
  "resume-capacity-blocked-recoveries";

export type RecoveryCapacityResumeJob = {
  shopId: string;
  trigger: string;
  recoveryId?: string;
};

export function createRecoveryCapacityResumeJobId(input: RecoveryCapacityResumeJob): string {
  return `recovery-capacity-resume--${input.shopId}--${input.trigger}`;
}

export function createRecoveryCapacityResumeContinuation(
  input: RecoveryCapacityResumeJob,
  lastRecoveryId: string,
): RecoveryCapacityResumeJob {
  return {
    shopId: input.shopId,
    trigger: `continuation-${lastRecoveryId}`,
  };
}

export function createRecoveryCapacityResumeMaturitySuccessor(input: {
  shopId: string;
  recoveryId: string;
  lastExternalActivityAt: Date;
  currentTrigger: string;
}): RecoveryCapacityResumeJob {
  const source = createHash("sha256")
    .update(input.currentTrigger)
    .digest("hex")
    .slice(0, 12);
  return {
    shopId: input.shopId,
    recoveryId: input.recoveryId,
    trigger: `recipient-suppression-${input.recoveryId}-maturity-${input.lastExternalActivityAt.getTime()}-after-${source}`,
  };
}