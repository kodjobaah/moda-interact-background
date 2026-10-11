import type { PrismaClient } from "@prisma/client";
import type { pendingRecoveryCandidateService } from "../pending-recovery-candidate.service.js";
import type { shopExecutionEligibilityService } from "../shop-execution-eligibility.service.js";
import type { recoveryCapacityResumeService } from "../recovery-capacity-resume.service.js";
import type { recoveryPolicyService } from "../recovery-policy.service.js";
import { createRecoveryCapacityResumeMaturitySuccessor } from "../../domain/recovery-capacity-resume.js";
import { isTargetedSuppressionWakeup } from "./recovery-capacity-resume-maturity.js";

type CheckoutLockPort = Pick<typeof pendingRecoveryCandidateService, "withCheckoutLock">;
type ExecutionEligibilityPort = Pick<typeof shopExecutionEligibilityService, "evaluate">;
type RecoveryResumeScheduler = Pick<typeof recoveryCapacityResumeService, "schedule">;
type RecoveryPolicyResolver = Pick<typeof recoveryPolicyService, "resolve">;

export async function runRecoveryCapacityResumeAdmissionGate(input: {
  database: PrismaClient;
  checkoutLock: CheckoutLockPort;
  eligibility: ExecutionEligibilityPort;
  scheduler: RecoveryResumeScheduler;
  policyResolver: RecoveryPolicyResolver;
  recoveryId: string;
  shopId: string;
  checkoutToken: string;
  wakeupTrigger?: string;
  clock: () => Date;
}) {
  const execution = await input.eligibility.evaluate(input.shopId, undefined, "recovery");
  if (!execution.allowed) return { kind: "ignored", reason: execution.reason } as const;

  const policy = isTargetedSuppressionWakeup(input.wakeupTrigger, input.recoveryId)
    ? await input.policyResolver.resolve(input.shopId)
    : null;
  const decision = await input.checkoutLock.withCheckoutLock(
    input.shopId,
    input.checkoutToken,
    async () => {
      const latest = await input.database.checkoutRecovery.findUnique({
        where: { id: input.recoveryId },
        select: {
          status: true,
          admissionBlockReason: true,
          lastExternalActivityAt: true,
        },
      });
      if (
        !latest ||
        latest.status !== "DETECTED" ||
        !isResumeEligibleBlockReason(
          latest.admissionBlockReason,
          input.wakeupTrigger,
          input.recoveryId,
        )
      ) {
        return { kind: "ignored", reason: "already-transitioned" } as const;
      }

      if (policy && input.wakeupTrigger) {
        const dueAt = new Date(
          latest.lastExternalActivityAt.getTime() + policy.recoveryDelayMinutes * 60_000,
        );
        if (dueAt > input.clock()) {
          return {
            kind: "defer" as const,
            dueAt,
            lastExternalActivityAt: latest.lastExternalActivityAt,
          };
        }
      }

      return { kind: "admit" as const };
    },
  );

  if (decision.kind !== "defer") return decision;
  const successor = createRecoveryCapacityResumeMaturitySuccessor({
    shopId: input.shopId,
    recoveryId: input.recoveryId,
    lastExternalActivityAt: decision.lastExternalActivityAt,
    currentTrigger: input.wakeupTrigger!,
  });
  await input.scheduler.schedule(successor, decision.dueAt);
  return { kind: "deferred-activity" as const, dueAt: decision.dueAt };
}

type AdmissionGateResult = Awaited<ReturnType<typeof runRecoveryCapacityResumeAdmissionGate>>;
type AdmissionGateOutcome = Exclude<AdmissionGateResult, { kind: "admit" }>;

export function createRecoveryCapacityResumeAdmissionGate(
  input: Parameters<typeof runRecoveryCapacityResumeAdmissionGate>[0],
) {
  const state: { outcome?: AdmissionGateOutcome } = {};
  return {
    state,
    check: async () => {
      const result = await runRecoveryCapacityResumeAdmissionGate(input);
      if (result.kind === "admit") return true;
      state.outcome = result;
      return false;
    },
  };
}

export function isResumeEligibleBlockReason(
  reason: string | null,
  wakeupTrigger?: string,
  recoveryId?: string,
): boolean {
  return reason === "RECOVERY_CAPACITY_EXHAUSTED" ||
    reason === "WHATSAPP_RECIPIENT_SUPPRESSED" ||
    (reason === null &&
      typeof wakeupTrigger === "string" &&
      typeof recoveryId === "string" &&
      wakeupTrigger.startsWith(`recipient-suppression-${recoveryId}-`));
}