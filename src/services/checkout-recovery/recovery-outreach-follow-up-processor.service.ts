import prisma from "../../lib/db.js";
import { outboundWhatsAppAdmissionService } from "../outbound-whatsapp-admission.service.js";
import { recoveryOutreachAttemptService } from "../recovery-outreach-attempt.service.js";
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

export class RecoveryOutreachFollowUpProcessorService {
  constructor(
    private readonly billingService: RecoveryBillingService = recoveryBillingService,
    private readonly finalizationService: RecoveryOutreachFinalizationService = new RecoveryOutreachFinalizationService(billingService),
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
            customer: { select: { phone: true } },
          },
        });
        const initial = recovery?.outreachAttempts.find((item) => item.sequence === 1);
        if (!recovery || !initial || !initial.sentAt || !initial.followUpDueAt || initial.followUpDueAt > new Date() || !recovery.conversation || !recovery.customer?.phone) {
          return { kind: "suppressed", reason: "not-due" } as const;
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
        const claimedNoResponse = await recoveryOutreachAttemptService.markNoResponseIfWaiting(initial.id);
        if (!claimedNoResponse || claimedNoResponse.count !== 1) {
          const currentAttempt = await recoveryOutreachAttemptService.getOrCreate({ recoveryId, sequence: 1, policy: await recoveryPolicyService.resolve(recovery.shopId) });
          if (currentAttempt.status === "ENGAGED" || ("customerRespondedAt" in currentAttempt && currentAttempt.customerRespondedAt)) {
            return { kind: "suppressed", reason: "engaged" } as const;
          }
          return { kind: "suppressed", reason: "already-claimed" } as const;
        }
        const attempt = await recoveryOutreachAttemptService.getOrCreateFollowUp({
          recoveryId,
          initialAttempt: initial,
        });
        const execution = await shopExecutionEligibilityService.evaluate(recovery.shopId);
        if (!execution.allowed) {
          await recoveryOutreachAttemptService.markStatus(attempt.id, "CANCELLED", { failureCode: execution.reason });
          return { kind: "suppressed", reason: execution.reason } as const;
        }
        const selection = await whatsappTemplateSelectorService.select({
          shopId: recovery.shopId,
          providerAccountId: outboundWhatsAppAdmissionService.getProviderAccountId(),
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
            senderType: "AUTOMATION",
            content,
            to: recovery.customer.phone,
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
          if (!providerSendCompleted) {
            await this.billingService.handleProviderFailure({ admission: billing.admission, error });
            await recoveryOutreachAttemptService.markStatus(attempt.id, "FAILED", { failureCode: "PROVIDER_FAILURE" });
          }
          throw error;
        }
      },
    );
  }
}