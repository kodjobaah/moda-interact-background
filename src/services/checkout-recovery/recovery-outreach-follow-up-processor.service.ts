import prisma from "../../lib/db.js";
import { outboundWhatsAppAdmissionService } from "../outbound-whatsapp-admission.service.js";
import { isSynchronousRecipientFailure } from "../whatsapp-provider-rejection.js";
import { recoveryOutreachAttemptService } from "../recovery-outreach-attempt.service.js";
import { recoveryOutreachFollowUpService } from "../recovery-outreach-follow-up.service.js";
import { recoveryPolicyService } from "../recovery-policy.service.js";
import {
  recoveryBillingService,
  type RecoveryBillingService,
} from "../recovery-billing.service.js";
import { pendingRecoveryCandidateService } from "../pending-recovery-candidate.service.js";
import { shopExecutionEligibilityService } from "../shop-execution-eligibility.service.js";
import { whatsappTemplateSelectorService } from "../whatsapp-template-selector.service.js";
import { conversationMessageService } from "../conversation.message.service.js";
import { RecoveryOutreachFinalizationService } from "./recovery-outreach-finalization.service.js";
import { recoveryRecipientResolverService } from "./recovery-recipient-resolver.service.js";
import { recoveryRecipientSuppressionAdmissionService } from "./recovery-recipient-suppression-admission.service.js";
import { classifyWhatsAppProviderFailure } from "../../domain/whatsapp-recipient-failure.js";
import { RecoveryFollowUpPolicyService } from "../recovery-conversation/recovery-follow-up-policy.service.js";
import { AiTurnOwnershipService } from "../recovery-conversation/ai-turn-ownership.service.js";

export class RecoveryOutreachFollowUpProcessorService {
  constructor(
    private readonly billingService: RecoveryBillingService = recoveryBillingService,
    private readonly finalizationService: RecoveryOutreachFinalizationService = new RecoveryOutreachFinalizationService(billingService),
    private readonly followUpPolicy = new RecoveryFollowUpPolicyService(),
    private readonly ownership = new AiTurnOwnershipService(),
  ) {}

  async process(recoveryId: string) {
    const lockTarget = await prisma.checkoutRecovery.findUnique({
      where: { id: recoveryId },
      select: { shopId: true, checkoutToken: true },
    });
    if (!lockTarget) return { kind: "suppressed", reason: "missing-recovery" } as const;
    return pendingRecoveryCandidateService.withCheckoutLock(
      lockTarget.shopId,
      lockTarget.checkoutToken,
      async () => {
        const recovery = await prisma.checkoutRecovery.findUnique({
          where: { id: recoveryId },
          include: {
            shop: { select: { domain: true, status: true } },
            outreachAttempts: { orderBy: { sequence: "asc" } },
            conversation: true,
          },
        });
        const initial = recovery?.outreachAttempts.find((item) => item.sequence === 1);
        if (!recovery || !initial || !initial.sentAt || !initial.followUpDueAt || initial.followUpDueAt > new Date() || !recovery.conversation) {
          return { kind: "suppressed", reason: "not-due" } as const;
        }
        if (initial.outboundMessageId) {
          const initialMessage = await prisma.conversationMessage.findUnique({
            where: { id: initial.outboundMessageId },
            select: { status: true, providerFailureCode: true },
          });
          if (
            initialMessage?.status === "FAILED" &&
            classifyWhatsAppProviderFailure(initialMessage.providerFailureCode) === "RECIPIENT_UNDELIVERABLE"
          ) {
            return { kind: "suppressed", reason: "recipient-undeliverable" } as const;
          }
        }
        if (["COMPLETED", "EXPIRED", "CANCELLED"].includes(recovery.status)) {
          return { kind: "suppressed", reason: "terminal" } as const;
        }
        if (recovery.outreachAttempts.some((item) => item.sequence === 2 && item.status === "WAITING_FOR_RESPONSE")) {
          return { kind: "suppressed", reason: "already-sent" } as const;
        }
        const engaged = recovery.conversation
          ? await prisma.conversationMessage.findFirst({
              where: { conversationId: recovery.conversation.id, direction: "INBOUND", createdAt: { gte: initial.sentAt } },
              orderBy: { createdAt: "asc" },
            })
          : null;
        if (engaged) {
          await recoveryOutreachAttemptService.markEngagedFromInbound(recoveryId, engaged.createdAt);
          return { kind: "suppressed", reason: "engaged" } as const;
        }
        const recipient = recovery.customerId
          ? await recoveryRecipientResolverService.resolveForCustomerInShop(recovery.customerId, recovery.shopId)
          : null;
        if (!recipient) return { kind: "suppressed", reason: "no-recipient" } as const;
        const suppression = await recoveryRecipientSuppressionAdmissionService.evaluate(
          recovery.shopId,
          recipient,
        );
        if (suppression.kind === "suppressed") {
          await recoveryOutreachFollowUpService.schedule(
            { checkoutRecoveryId: recoveryId, sequence: 2 },
            suppression.until,
          );
          return {
            kind: "suppressed",
            reason: "WHATSAPP_RECIPIENT_SUPPRESSED",
          } as const;
        }
        const owner = await this.ownership.readTurnOwnership(recovery.conversation.id);
        if (!owner || owner.mode !== "AI" || owner.shopId !== recovery.shopId) {
          return { kind: "suppressed", reason: "human-controlled" } as const;
        }
        const claimedNoResponse = await recoveryOutreachAttemptService.markNoResponseIfWaiting(initial.id);
        if (!claimedNoResponse || claimedNoResponse.count !== 1) {
          const currentAttempt = await recoveryOutreachAttemptService.getOrCreate({ recoveryId, sequence: 1, policy: await recoveryPolicyService.resolve(recovery.shopId), recipient: initial.recipient });
          if (currentAttempt.status === "ENGAGED" || ("customerRespondedAt" in currentAttempt && currentAttempt.customerRespondedAt)) {
            return { kind: "suppressed", reason: "engaged" } as const;
          }
          return { kind: "suppressed", reason: "already-claimed" } as const;
        }
        // The scheduled job competes with merchant-approved templates for the
        // SAME sequence-two row. Never create an unclaimed second attempt here.
        const initiationKey = `scheduled-no-response:${recoveryId}`;
        const claim = await this.followUpPolicy.claimSequenceTwo({
          recoveryId, initiator: "scheduled_no_response", initiationKey,
          recipient, now: new Date(),
        });
        if (claim.kind === "suppressed" && claim.reason !== "already-claimed")
          return claim;
        const attempt = await prisma.recoveryOutreachAttempt.findUnique({
          where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: recoveryId, sequence: 2 } },
        });
        if (!attempt || attempt.initiatedBy !== "AUTOMATION" ||
            attempt.initiationKey !== initiationKey || attempt.outboundMessageId ||
            attempt.status !== "PENDING")
          return { kind: "suppressed", reason: "already-claimed" } as const;
        const execution = await shopExecutionEligibilityService.evaluate(
          recovery.shopId,
          undefined,
          "recovery",
        );
        if (!execution.allowed) {
          await recoveryOutreachAttemptService.markStatus(attempt.id, "CANCELLED", { failureCode: execution.reason });
          return { kind: "suppressed", reason: execution.reason } as const;
        }
        const selection = await whatsappTemplateSelectorService.select({
          shopId: recovery.shopId,
          providerAccountId: await outboundWhatsAppAdmissionService.getProviderAccountId(),
          purpose: "checkout-recovery",
          languageTag: recovery.conversation?.languageTag ?? null,
          countryCode: recovery.conversation?.countryCode ?? null,
          resolveMarketCapability: async () => "unknown" as const,
        });
        if (selection.outcome !== "selected" && selection.outcome !== "provider-check-required") {
          await recoveryOutreachAttemptService.markStatus(attempt.id, "FAILED", { failureCode: "TEMPLATE_UNAVAILABLE" });
          return { kind: "suppressed", reason: "template-unavailable" } as const;
        }
        let billing = await this.billingService.admit({ shopId: recovery.shopId, recoveryId, outreachAttemptId: attempt.id });
        if (billing.kind === "blocked") {
          await recoveryOutreachAttemptService.markStatus(attempt.id, "CAPACITY_BLOCKED", { failureCode: billing.reason });
          return { kind: "capacity-blocked", reason: billing.reason } as const;
        }
        const revalidated = await this.billingService.revalidateBeforeProvider({
          admission: billing.admission,
          recoveryId,
          outreachAttemptId: attempt.id,
        });
        if (revalidated.kind === "blocked") {
          await recoveryOutreachAttemptService.markStatus(attempt.id, "CAPACITY_BLOCKED", { failureCode: revalidated.reason });
          return { kind: "capacity-blocked", reason: revalidated.reason } as const;
        }
        billing = revalidated;
        const content = conversationMessageService.buildRecoveryTemplateDescriptor({
          purpose: "checkout-recovery",
          templateName: selection.providerTemplateName,
          canonicalLanguageTag: selection.canonicalLanguageTag,
          providerLanguageCode: selection.providerLanguageCode,
        });
        let providerSendCompleted = false;
        try {
          const result = await outboundWhatsAppAdmissionService.sendTemplate({
            shopId: recovery.shopId,
            conversationId: recovery.conversation.id,
            idempotencyKey: `recovery-outreach:${attempt.id}`,
            recoveryCreditSourceKey: billing.admission.sourceKey,
            senderType: "AUTOMATION",
            expectedControlRevision: owner.revision,
            content,
            to: attempt.recipient,
            templateName: selection.providerTemplateName,
            languageCode: selection.providerLanguageCode,
          });
          providerSendCompleted = true;
          if (result.kind === "suppressed") {
            if (result.reason === "duplicate") {
              const existing = await outboundWhatsAppAdmissionService.findExistingAdmission(`recovery-outreach:${attempt.id}`);
              if (existing?.status === "SENT" || existing?.status === "DELIVERED" || existing?.status === "READ") {
                this.finalizationService.requireConfirmedMessage(existing, recovery.conversation.id, attempt.id);
                await this.finalizationService.finalizeConfirmedOutreach({ recovery, attempt, admission: billing.admission, message: existing });
                return { kind: "sent", attemptId: attempt.id } as const;
              }
              if (existing?.status === "PENDING") {
                throw new Error(`Recovery outreach send is still pending for attempt ${attempt.id}`);
              }
              if (
                existing?.status === "FAILED" &&
                classifyWhatsAppProviderFailure(existing.providerFailureCode) ===
                  "RECIPIENT_UNDELIVERABLE"
              ) {
                // Only persisted 131026 evidence permits this classification.
                // Keep the corrected attempt's terminal evidence intact.
                await this.billingService.releaseBeforeProvider(billing.admission);
                return { kind: "suppressed", reason: "recipient-undeliverable" } as const;
              }
              if (!existing) {
                throw new Error(`Recovery outreach admission has no durable message for attempt ${attempt.id}`);
              }
            }
            await this.billingService.releaseBeforeProvider(billing.admission);
            await recoveryOutreachAttemptService.markStatus(attempt.id, "FAILED", { failureCode: result.reason });
            return result;
          }
          const persistedMessage = await outboundWhatsAppAdmissionService.findExistingAdmission(`recovery-outreach:${attempt.id}`);
          this.finalizationService.requireConfirmedMessage(persistedMessage, recovery.conversation.id, attempt.id);
          await this.finalizationService.finalizeConfirmedOutreach({ recovery, attempt, admission: billing.admission, message: persistedMessage });
          return { kind: "sent", attemptId: attempt.id } as const;
        } catch (error) {
          if (!providerSendCompleted && !isSynchronousRecipientFailure(error)) {
            await this.billingService.handleProviderFailure({ admission: billing.admission, error });
            await recoveryOutreachAttemptService.markStatus(attempt.id, "FAILED", { failureCode: "PROVIDER_FAILURE" });
          }
          throw error;
        }
      },
    );
  }
}