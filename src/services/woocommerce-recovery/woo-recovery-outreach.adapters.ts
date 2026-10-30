import prisma from "../../lib/db.js";
import { recoveryRecipientResolverService } from "../checkout-recovery/recovery-recipient-resolver.service.js";
import { recoveryOutreachAttemptService } from "../recovery-outreach-attempt.service.js";
import { recoveryPolicyService } from "../recovery-policy.service.js";
import { recoveryBillingService } from "../recovery-billing.service.js";
import { recoveryInitialOutreachSupportNoticeService } from "../checkout-recovery/recovery-initial-outreach-support-notice.service.js";
import { conversationService } from "../conversation.service.js";
import { automatedRecoveryTemplateService } from "../recovery-template-integration/automated-recovery-template.service.js";
import { wooRecoveryConsentReader } from "../woocommerce-recovery-consent.service.js";
import { isSynchronousRecipientFailure } from "../whatsapp-provider-rejection.js";
import { recoveryDeliveryCompensationService } from "../recovery-delivery-compensation/reconcile.service.js";
import { WooRecoveryOutreachService, type WooOutreachDependencies, type WooGuardedInitialSender } from "./woo-recovery-outreach.service.js";
import type { WooCheckoutCoordinator, WooObservedOrderStateReader } from "./contracts.js";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooResumedOutreachSettlementAdapter } from "./woo-resumed-outreach-settlement.adapter.js";

/**
 * BG004's existing-service adapters. No queue, worker or provider is registered.
 * The caller MUST provide BG002's fenced checkout coordinator/order reader and
 * a reviewed ARCH-046 Woo final-send implementation. This snapshot's generic
 * outbound sender is not eligible as a WooGuardedInitialSender: it bypasses
 * Woo consent in the final SQL permit.
 */
export function createWooRecoveryOutreachService(input: {
  coordinator: WooCheckoutCoordinator;
  orders: WooObservedOrderStateReader;
  guardedSender: WooGuardedInitialSender;
  enqueue: WooOutreachDependencies["enqueue"];
  logger: StructuredLogger;
  enableTestOutbound?: () => boolean;
}): WooRecoveryOutreachService {
  return new WooRecoveryOutreachService({
    logger: input.logger,
    coordinator: input.coordinator,
    orders: input.orders,
    sender: input.guardedSender,
    enqueue: input.enqueue,
    ...(input.enableTestOutbound ? { enableTestOutbound: input.enableTestOutbound } : {}),
    recoveries: {
      async get(recoveryId) {
        return prisma.checkoutRecovery.findUnique({
          where: { id: recoveryId },
          select: {
            id: true, shopId: true, checkoutToken: true, customerId: true,
            status: true, completedAt: true,
            shop: { select: { platform: true, status: true } },
          },
        });
      },
      currentRecipient: (customerId, shopId) =>
        recoveryRecipientResolverService.resolveForCustomerInShop(customerId, shopId),
    },
    attempts: {
      async findInitial(recoveryId) {
        return prisma.recoveryOutreachAttempt.findUnique({
          where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: recoveryId, sequence: 1 } },
          select: { id: true, sequence: true, recipient: true, status: true,
            sentAt: true, outboundMessageId: true, followUpDueAt: true },
        });
      },
      getOrCreateInitial: async ({ recoveryId, recipient, policy }) =>
        recoveryOutreachAttemptService.getOrCreate({ recoveryId, sequence: 1, recipient, policy }),
      async markFailed(attemptId, reason) {
        const updated = await prisma.recoveryOutreachAttempt.updateMany({
          where: {
            id: attemptId, sequence: 1, sentAt: null, outboundMessageId: null,
            status: { in: ["PENDING", "CAPACITY_BLOCKED", "CANCELLED"] },
          },
          data: { status: "FAILED", failureCode: reason },
        });
        if (updated.count === 0) {
          const current = await prisma.recoveryOutreachAttempt.findUnique({
            where: { id: attemptId }, select: { status: true, sentAt: true, outboundMessageId: true },
          });
          if (!current || current.sentAt || current.outboundMessageId || current.status !== "FAILED")
            throw new Error("WOO_ATTEMPT_FAILURE_TRANSITION_CONFLICT");
        }
      },
    },
    consent: wooRecoveryConsentReader,
    policies: recoveryPolicyService,
    templates: {
      async select(shopId, recoveryId, policy) {
        const conversation = await prisma.conversation.findUnique({
          where: { checkoutRecoveryId: recoveryId },
          select: { languageTag: true },
        });
        const selected = await automatedRecoveryTemplateService.prepare({
          shopId, recoveryId, stage: "INITIAL",
          policy: policy ?? await recoveryPolicyService.resolve(shopId),
          conversationLanguageTag: conversation?.languageTag ?? null,
        });
        if (selected.kind !== "prepared") {
          return { kind: "unavailable" as const, reason: selected.reason };
        }
        return {
          kind: "selected" as const,
          template: {
            name: selected.prepared.providerTemplateName,
            languageCode: selected.prepared.providerLanguageCode,
            canonicalLanguageTag: selected.prepared.canonicalLanguageTag,
            verifiedCategory: "MARKETING" as const,
            sendFields: selected.send,
          },
        };
      },
    },
    conversations: {
      async getOrCreate(recoveryId) {
        return conversationService.getOrCreateRecoveryConversation(recoveryId);
      },
    },
    billing: recoveryBillingService,
    providerFailure: {
      async compensate(admission, error) {
        // Existing 131026 implementation already records failure evidence,
        // compensates the exact source and notifies the merchant. Do not
        // duplicate that correction in another owner.
        if (!isSynchronousRecipientFailure(error)) {
          await recoveryBillingService.handleProviderFailure({ admission, error });
        }
      },
      async reconcileRecorded({ admission, messageId, error }) {
        if (isSynchronousRecipientFailure(error)) {
          const result = await recoveryDeliveryCompensationService.reconcileMessage(messageId);
          if (result === "not-terminal" || result === "not-recovery")
            throw new Error("WOO_RECORDED_PROVIDER_FAILURE_COMPENSATION_UNRESOLVED");
          return;
        }
        await recoveryBillingService.handleProviderFailure({ admission, error });
      },
    },
    resumedSettlement: new WooResumedOutreachSettlementAdapter(),
    finalize: {
      async confirmed({ recovery, attempt, message, admission }) {
        if (attempt.sequence !== 1 || attempt.followUpDueAt !== null)
          throw new Error("WOO_FOLLOW_UP_NOT_ALLOWED");
        if (message.conversationId !== (await prisma.conversation.findUnique({
          where: { checkoutRecoveryId: recovery.id }, select: { id: true },
        }))?.id) throw new Error("WOO_INITIAL_MESSAGE_CONVERSATION_MISMATCH");
        let stage: "billing" | "support_notice" | "recovery_status" = "billing";
        try {
          await recoveryBillingService.commitSuccessfulInitiation({
            admission, recoveryId: recovery.id, occurredAt: message.sentAt,
          });
          stage = "support_notice";
          await recoveryInitialOutreachSupportNoticeService.finalizeConfirmedInitial({
            shopId: recovery.shopId,
            checkoutRecoveryId: recovery.id,
            outreachAttemptId: attempt.id,
            outboundMessageId: message.id,
            sentAt: message.sentAt,
            followUpDueAt: null,
          });
          stage = "recovery_status";
          await prisma.checkoutRecovery.updateMany({
            where: { id: recovery.id, shopId: recovery.shopId, status: "DETECTED" },
            data: { status: "MESSAGE_SENT", messageSentAt: message.sentAt,
              admissionBlockedAt: null, admissionBlockReason: null },
          });
        } catch (error) {
          try {
            input.logger.error("recovery.initial_outreach_support_notice.woocommerce_finalization_failed", {
              shopId: recovery.shopId,
              checkoutRecoveryId: recovery.id,
              outreachAttemptId: attempt.id,
              outboundMessageId: message.id,
              stage,
              error,
            });
          } catch {
            // Preserve the original finalization failure if the logging sink fails.
          }
          throw error;
        }
      },
    },
  });
}
