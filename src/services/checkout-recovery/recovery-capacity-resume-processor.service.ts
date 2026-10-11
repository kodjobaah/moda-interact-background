import type { PrismaClient } from "@prisma/client";
import type { RecoveryCheckoutSeed } from "../../events/checkout-events.js";
import type { PendingRecoveryCandidate } from "../../domain/pending-recovery-candidate.js";
import type { abandonedCheckoutLookupService } from "../abandoned-checkout-lookup.service.js";
import type { pendingRecoveryCandidateService } from "../pending-recovery-candidate.service.js";
import type { shopExecutionEligibilityService } from "../shop-execution-eligibility.service.js";
import type { recoverySnapshotBuilderService } from "./recovery-snapshot-builder.service.js";
import {
  recoveryRecipientResolverService,
  type RecoveryRecipientResolverService,
} from "./recovery-recipient-resolver.service.js";
import {
  recoveryRecipientSuppressionAdmissionService,
  type RecoveryRecipientSuppressionAdmissionService,
} from "./recovery-recipient-suppression-admission.service.js";

type CheckoutLockPort = Pick<typeof pendingRecoveryCandidateService, "withCheckoutLock">;
type ExecutionEligibilityPort = Pick<typeof shopExecutionEligibilityService, "evaluate">;
type AbandonedCheckoutLookupPort = Pick<typeof abandonedCheckoutLookupService, "lookup">;
type RecoverySnapshotBuilderPort = Pick<typeof recoverySnapshotBuilderService, "build">;
type RecoveryRecipientResolverPort = Pick<RecoveryRecipientResolverService, "resolve" | "resolveForCustomerInShop">;
type SuppressionAdmissionPort = Pick<RecoveryRecipientSuppressionAdmissionService, "clearDetectedSuppression">;
type RecoveryInitiationPort = (
  seed: RecoveryCheckoutSeed,
  generation?: number,
  recipient?: string,
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
  ) {}

  async resume(recoveryId: string) {
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
      !isResumeEligibleBlockReason(recovery.admissionBlockReason)
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

    return this.pendingRecoveryCandidateService.withCheckoutLock(
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
          },
        });
        if (
          !current ||
          current.status !== "DETECTED" ||
          !isResumeEligibleBlockReason(current.admissionBlockReason)
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

        const outcome = await this.abandonedCheckoutLookupService.lookup({
          shopId: recovery.shopId,
          shopDomain: recovery.shop.domain,
          checkoutToken: current.checkoutToken,
          cartToken: current.cartToken,
          abandonedCheckoutUrl: current.checkoutUrl,
          checkoutCreatedAt: current.detectedAt.toISOString(),
        });
        if (outcome.kind === "provider-error") {
          throw new Error(
            `Abandoned checkout provider error while resuming recovery ${recovery.id}: ${outcome.message}`,
          );
        }
        if (
          outcome.kind === "ambiguous" ||
          outcome.kind === "bounded-limit-exceeded"
        ) {
          throw new Error(
            `Abandoned checkout lookup ${outcome.kind} while resuming recovery ${recovery.id}`,
          );
        }
        if (outcome.kind === "not-found" || outcome.checkout.completedAt !== null) {
          await this.terminalizeUnrecoverableBlockedRecovery(
            recovery.id,
            outcome.kind === "found" ? "Checkout completed" : "Checkout lookup not-found",
          );
          return { kind: "terminal", reason: outcome.kind } as const;
        }

        const candidate: PendingRecoveryCandidate = {
          shopId: recovery.shopId,
          shopDomain: recovery.shop.domain,
          checkoutToken: current.checkoutToken,
          cartToken: current.cartToken,
          abandonedCheckoutUrl: current.checkoutUrl,
          checkoutCreatedAt: current.detectedAt.toISOString(),
        };
        const seed = await this.snapshotBuilder.build(
          candidate,
          recovery.shop.domain,
          outcome.checkout,
        );
        const recipient = await this.recipientResolver.resolve(seed) ??
          (current.customerId
            ? await this.recipientResolver.resolveForCustomerInShop(
                current.customerId,
                recovery.shopId,
              )
            : null);
        if (!recipient) {
          if (current.admissionBlockReason === "WHATSAPP_RECIPIENT_SUPPRESSED") {
            await this.suppressionAdmission.clearDetectedSuppression(recovery.id);
          }
          return { kind: "suppressed" as const, reason: "no-recipient" };
        }
        await this.initiate(seed, current.generation ?? 1, recipient);
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
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const updated = await transaction.checkoutRecovery.updateMany({
        where: {
          id: recoveryId,
          status: "DETECTED",
          admissionBlockReason: {
            in: ["RECOVERY_CAPACITY_EXHAUSTED", "WHATSAPP_RECIPIENT_SUPPRESSED"],
          },
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

function isResumeEligibleBlockReason(reason: string | null): boolean {
  return reason === "RECOVERY_CAPACITY_EXHAUSTED" ||
    reason === "WHATSAPP_RECIPIENT_SUPPRESSED";
}