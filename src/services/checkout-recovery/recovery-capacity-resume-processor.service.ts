import type { PrismaClient } from "@prisma/client";
import type { RecoveryCheckoutSeed } from "../../events/checkout-events.js";
import type { abandonedCheckoutLookupService } from "../abandoned-checkout-lookup.service.js";
import type { pendingRecoveryCandidateService } from "../pending-recovery-candidate.service.js";
import type { shopExecutionEligibilityService } from "../shop-execution-eligibility.service.js";
import type { recoverySnapshotBuilderService } from "./recovery-snapshot-builder.service.js";
import { recoveryCapacityResumeService } from "../recovery-capacity-resume.service.js";
import { recoveryPolicyService } from "../recovery-policy.service.js";
import {
  recoveryRecipientResolverService,
  type RecoveryRecipientResolverService,
} from "./recovery-recipient-resolver.service.js";
import {
  recoveryRecipientSuppressionAdmissionService,
  type RecoveryRecipientSuppressionAdmissionService,
} from "./recovery-recipient-suppression-admission.service.js";
import {
  deferRecoveryCapacityResumeUntilMature,
  isTargetedSuppressionWakeup,
} from "./recovery-capacity-resume-maturity.js";
import { prepareRecoveryCapacityResumeCheckout } from "./recovery-capacity-resume-checkout-preparation.js";

type CheckoutLockPort = Pick<typeof pendingRecoveryCandidateService, "withCheckoutLock">;
type ExecutionEligibilityPort = Pick<typeof shopExecutionEligibilityService, "evaluate">;
type AbandonedCheckoutLookupPort = Pick<typeof abandonedCheckoutLookupService, "lookup">;
type RecoverySnapshotBuilderPort = Pick<typeof recoverySnapshotBuilderService, "build">;
type RecoveryRecipientResolverPort = Pick<RecoveryRecipientResolverService, "resolve" | "resolveForCustomerInShop">;
type SuppressionAdmissionPort = Pick<RecoveryRecipientSuppressionAdmissionService, "clearDetectedSuppression">;
type RecoveryResumeScheduler = Pick<typeof recoveryCapacityResumeService, "schedule">;
type RecoveryPolicyResolver = Pick<typeof recoveryPolicyService, "resolve">;
type RecoveryInitiationPort = (
  seed: RecoveryCheckoutSeed,
  generation?: number,
  recipient?: string,
  suppressionWakeupTrigger?: string,
) => Promise<unknown>;

export class RecoveryCapacityResumeProcessorService {
  constructor(
    private readonly database: PrismaClient,
    private readonly pendingRecoveryCandidateService: CheckoutLockPort,
    private readonly shopExecutionEligibilityService: ExecutionEligibilityPort,
    private readonly abandonedCheckoutLookupService: AbandonedCheckoutLookupPort,
    private readonly snapshotBuilder: RecoverySnapshotBuilderPort,
    private readonly initiate: RecoveryInitiationPort,
    private readonly recipientResolver: RecoveryRecipientResolverPort = recoveryRecipientResolverService,
    private readonly suppressionAdmission: SuppressionAdmissionPort = recoveryRecipientSuppressionAdmissionService,
    private readonly recoveryResumeScheduler: RecoveryResumeScheduler = recoveryCapacityResumeService,
    private readonly recoveryPolicyResolver: RecoveryPolicyResolver = recoveryPolicyService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async resume(recoveryId: string, wakeupTrigger?: string) {
    const recovery = await this.database.checkoutRecovery.findUnique({
      where: { id: recoveryId },
      select: {
        id: true,
        shopId: true,
        checkoutToken: true,
        cartToken: true,
        checkoutUrl: true,
        detectedAt: true,
        generation: true,
        customerId: true,
        status: true,
        admissionBlockReason: true,
        shop: { select: { domain: true, status: true } },
      },
    });
    if (
      !recovery ||
      recovery.status !== "DETECTED" ||
      !isResumeEligibleBlockReason(recovery.admissionBlockReason, wakeupTrigger, recoveryId)
    ) {
      return { kind: "ignored", reason: "not-capacity-blocked" } as const;
    }
    if (recovery.shop.status !== "ACTIVE") {
      return { kind: "ignored", reason: "shop-unavailable" } as const;
    }
    const execution = await this.shopExecutionEligibilityService.evaluate(
      recovery.shopId,
      undefined,
      "recovery",
    );
    if (!execution.allowed) {
      return { kind: "ignored", reason: execution.reason } as const;
    }

    const prepared = await this.pendingRecoveryCandidateService.withCheckoutLock(
      recovery.shopId,
      recovery.checkoutToken,
      async () => {
        const current = await this.database.checkoutRecovery.findUnique({
          where: { id: recovery.id },
          select: {
            id: true,
            status: true,
            admissionBlockReason: true,
            checkoutToken: true,
            cartToken: true,
            checkoutUrl: true,
            detectedAt: true,
            generation: true,
            customerId: true,
            lastExternalActivityAt: true,
          },
        });
        if (
          !current ||
          current.status !== "DETECTED" ||
          !isResumeEligibleBlockReason(current.admissionBlockReason, wakeupTrigger, recoveryId)
        ) {
          return { kind: "ignored", reason: "already-transitioned" } as const;
        }
        const lockedExecution = await this.shopExecutionEligibilityService.evaluate(
          recovery.shopId,
          undefined,
          "recovery",
        );
        if (!lockedExecution.allowed) {
          return { kind: "ignored", reason: lockedExecution.reason } as const;
        }

        const deferred = await deferRecoveryCapacityResumeUntilMature({
          recoveryId: recovery.id,
          shopId: recovery.shopId,
          lastExternalActivityAt: current.lastExternalActivityAt,
          wakeupTrigger,
          scheduler: this.recoveryResumeScheduler,
          policyResolver: this.recoveryPolicyResolver,
          clock: this.clock,
        });
        return deferred ?? { kind: "ready" as const, current };
      },
    );
    if (prepared.kind !== "ready") return prepared;

    const current = prepared.current;
    const { outcome, terminal, seed, recipient } = await prepareRecoveryCapacityResumeCheckout({
      recovery: {
        id: recovery.id,
        shopId: recovery.shopId,
        checkoutToken: current.checkoutToken,
        cartToken: current.cartToken,
        checkoutUrl: current.checkoutUrl,
        detectedAt: current.detectedAt,
        customerId: current.customerId,
      },
      shopDomain: recovery.shop.domain,
      lookup: this.abandonedCheckoutLookupService,
      snapshotBuilder: this.snapshotBuilder,
      recipientResolver: this.recipientResolver,
    });

    return this.pendingRecoveryCandidateService.withCheckoutLock(
      recovery.shopId,
      recovery.checkoutToken,
      async () => {
        const latest = await this.database.checkoutRecovery.findUnique({
          where: { id: recovery.id },
          select: {
            id: true,
            status: true,
            admissionBlockReason: true,
            checkoutToken: true,
            cartToken: true,
            checkoutUrl: true,
            detectedAt: true,
            generation: true,
            customerId: true,
            lastExternalActivityAt: true,
          },
        });
        if (
          !latest ||
          latest.status !== "DETECTED" ||
          !isResumeEligibleBlockReason(latest.admissionBlockReason, wakeupTrigger, recoveryId)
        ) {
          return { kind: "ignored", reason: "already-transitioned" } as const;
        }
        const finalExecution = await this.shopExecutionEligibilityService.evaluate(
          recovery.shopId,
          undefined,
          "recovery",
        );
        if (!finalExecution.allowed) {
          return { kind: "ignored", reason: finalExecution.reason } as const;
        }

        const deferred = await deferRecoveryCapacityResumeUntilMature({
          recoveryId: recovery.id,
          shopId: recovery.shopId,
          lastExternalActivityAt: latest.lastExternalActivityAt,
          wakeupTrigger,
          scheduler: this.recoveryResumeScheduler,
          policyResolver: this.recoveryPolicyResolver,
          clock: this.clock,
        });
        if (deferred) return deferred;

        if (terminal) {
          await this.terminalizeUnrecoverableBlockedRecovery(
            recovery.id,
            outcome.kind === "found" ? "Checkout completed" : "Checkout lookup not-found",
            latest.admissionBlockReason === null && isTargetedSuppressionWakeup(wakeupTrigger, recovery.id),
          );
          return { kind: "terminal", reason: outcome.kind } as const;
        }
        if (!recipient || !seed) {
          if (
            latest.admissionBlockReason === "WHATSAPP_RECIPIENT_SUPPRESSED" ||
            isTargetedSuppressionWakeup(wakeupTrigger, recovery.id)
          ) {
            await this.suppressionAdmission.clearDetectedSuppression(recovery.id);
          }
          return { kind: "suppressed" as const, reason: "no-recipient" };
        }

        await this.initiate(seed, latest.generation ?? 1, recipient, wakeupTrigger);
        const after = await this.database.checkoutRecovery.findUnique({
          where: { id: recovery.id },
          select: { status: true, admissionBlockReason: true },
        });
        if (after?.admissionBlockReason === "RECOVERY_CAPACITY_EXHAUSTED") {
          return { kind: "capacity-exhausted" as const };
        }
        if (after?.admissionBlockReason === "WHATSAPP_RECIPIENT_SUPPRESSED") {
          return { kind: "suppressed" as const, reason: "WHATSAPP_RECIPIENT_SUPPRESSED" };
        }
        return { kind: "initiated" as const, status: after?.status ?? "DETECTED" };
      },
    );
  }

  private async terminalizeUnrecoverableBlockedRecovery(
    recoveryId: string,
    reason: string,
    allowUnblockedSuppressionWakeup = false,
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const updated = await transaction.checkoutRecovery.updateMany({
        where: {
          id: recoveryId,
          status: "DETECTED",
          ...(allowUnblockedSuppressionWakeup
            ? {
                OR: [
                  { admissionBlockReason: null },
                  { admissionBlockReason: { in: ["RECOVERY_CAPACITY_EXHAUSTED", "WHATSAPP_RECIPIENT_SUPPRESSED"] } },
                ],
              }
            : {
                admissionBlockReason: { in: ["RECOVERY_CAPACITY_EXHAUSTED", "WHATSAPP_RECIPIENT_SUPPRESSED"] },
              }),
        },
        data: {
          status: "CANCELLED",
          expiredAt: new Date(),
          admissionBlockedAt: null,
          admissionBlockReason: null,
        },
      });
      if (updated.count === 1) {
        await transaction.checkoutRecoveryStatusHistory.create({
          data: {
            checkoutRecoveryId: recoveryId,
            fromStatus: "DETECTED",
            toStatus: "CANCELLED",
            reason,
            source: "recovery-capacity-resume",
          },
        });
      }
    });
  }
}

function isResumeEligibleBlockReason(
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
