import { createRecoveryCapacityResumeMaturitySuccessor } from "../../domain/recovery-capacity-resume.js";
import type { recoveryCapacityResumeService } from "../recovery-capacity-resume.service.js";
import type { recoveryPolicyService } from "../recovery-policy.service.js";

type RecoveryResumeScheduler = Pick<typeof recoveryCapacityResumeService, "schedule">;
type RecoveryPolicyResolver = Pick<typeof recoveryPolicyService, "resolve">;

export function isTargetedSuppressionWakeup(
  wakeupTrigger: string | undefined,
  recoveryId: string,
): boolean {
  return typeof wakeupTrigger === "string" &&
    wakeupTrigger.startsWith(`recipient-suppression-${recoveryId}-`);
}

export async function deferRecoveryCapacityResumeUntilMature(input: {
  recoveryId: string;
  shopId: string;
  lastExternalActivityAt: Date;
  wakeupTrigger: string | undefined;
  scheduler: RecoveryResumeScheduler;
  policyResolver: RecoveryPolicyResolver;
  clock: () => Date;
}) {
  const {
    recoveryId,
    shopId,
    lastExternalActivityAt,
    wakeupTrigger,
    scheduler,
    policyResolver,
    clock,
  } = input;
  if (!wakeupTrigger || !isTargetedSuppressionWakeup(wakeupTrigger, recoveryId)) return null;
  const policy = await policyResolver.resolve(shopId);
  const maturityAt = new Date(
    lastExternalActivityAt.getTime() + policy.recoveryDelayMinutes * 60_000,
  );
  if (maturityAt <= clock()) return null;

  const successor = createRecoveryCapacityResumeMaturitySuccessor({
    shopId,
    recoveryId,
    lastExternalActivityAt,
    currentTrigger: wakeupTrigger,
  });
  await scheduler.schedule(successor, maturityAt);
  return { kind: "deferred-activity" as const, dueAt: maturityAt };
}