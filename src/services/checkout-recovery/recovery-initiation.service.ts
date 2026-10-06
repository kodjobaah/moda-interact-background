import { Prisma } from "@prisma/client";
import type { RecoveryCheckoutSeed } from "../../events/checkout-events.js";
import prisma from "../../lib/db.js";
import { customerService } from "../customer.service.js";
import { conversationService } from "../conversation.service.js";
import { conversationMessageService } from "../conversation.message.service.js";
import { outboundWhatsAppAdmissionService } from "../outbound-whatsapp-admission.service.js";
import { whatsappTemplateSelectorService } from "../whatsapp-template-selector.service.js";
import {
  recoveryBillingService,
  type RecoveryBillingService,
} from "../recovery-billing.service.js";
import { recoveryPolicyService } from "../recovery-policy.service.js";
import { recoveryOutreachAttemptService } from "../recovery-outreach-attempt.service.js";
import { findLatestRecovery } from "./latest-recovery.js";
import { RecoveryOutreachFinalizationService } from "./recovery-outreach-finalization.service.js";

type Recovery = NonNullable<Awaited<ReturnType<typeof prisma.checkoutRecovery.findFirst>>>;

interface RecoveryInitiationPorts {
  upsertRecovery: (event: RecoveryCheckoutSeed, generation: number) => Promise<Recovery | null>;
  resolveRecipient: (event: RecoveryCheckoutSeed) => string;
  markRecoveryCapacityBlocked: (recoveryId: string) => Promise<unknown>;
}

export class RecoveryInitiationService {
  constructor(
    private readonly billingService: RecoveryBillingService = recoveryBillingService,
    private readonly finalizationService: RecoveryOutreachFinalizationService = new RecoveryOutreachFinalizationService(billingService),
    private readonly ports?: RecoveryInitiationPorts,
  ) {}

  async upsertRecovery(event: RecoveryCheckoutSeed, generation = 1) {
    const shop = await prisma.shop.findUniqueOrThrow({
      where: { domain: event.shop },
      select: { id: true },
    });
    try {
      return await prisma.checkoutRecovery.create({
        data: {
          shopId: shop.id,
          checkoutToken: event.checkoutToken,
          cartToken: event.cartToken,
          status: "DETECTED",
          generation,
          currency: event.currency,
          totalPrice: event.totalPrice !== null ? event.totalPrice : null,
          checkoutUrl: event.checkoutUrl,
          lineItems: event.lineItems,
          detectedAt: new Date(event.detectedAt),
          lastExternalActivityAt: new Date(event.lastExternalActivityAt ?? event.detectedAt),
          completedAt: event.completedAt !== null ? new Date(event.completedAt) : null,
        },
      });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      return findLatestRecovery(shop.id, event.checkoutToken);
    }
  }

  async attachCustomer(recoveryId: string, customerId: string) {
    return prisma.checkoutRecovery.updateMany({
      where: { id: recoveryId, status: "DETECTED" },
      data: { customerId },
    });
  }

  resolveRecipient(event: RecoveryCheckoutSeed): string {
    if (event.customer.phone) return event.customer.phone;
    const testRecipient = process.env.TEST_WHATSAPP_RECIPIENT;
    if (!testRecipient) {
      throw new Error("No customer phone and TEST_WHATSAPP_RECIPIENT is not configured");
    }
    return testRecipient;
  }

  async markRecoveryMessageSent(recoveryId: string) {
    return prisma.checkoutRecovery.updateMany({
      where: { id: recoveryId, status: "DETECTED" },
      data: {
        status: "MESSAGE_SENT",
        messageSentAt: new Date(),
        admissionBlockedAt: null,
        admissionBlockReason: null,
      },
    });
  }

  async markRecoveryCapacityBlocked(recoveryId: string, blockedAt = new Date()) {
    return prisma.checkoutRecovery.updateMany({
      where: {
        id: recoveryId,
        status: "DETECTED",
        admissionBlockReason: null,
      },
      data: {
        admissionBlockedAt: blockedAt,
        admissionBlockReason: "RECOVERY_CAPACITY_EXHAUSTED",
      },
    });
  }

  async handleCheckoutCreated(event: RecoveryCheckoutSeed, generation = 1) {
    let recovery = await this.ports!.upsertRecovery(event, generation);
    if (!recovery) {
      throw new Error(`Recovery generation was not materialized for ${event.checkoutToken}`);
    }

    const customer = await customerService.resolveCustomer(event);
    if (customer && recovery.customerId !== customer.id) {
      recovery = await prisma.checkoutRecovery.update({
        where: { id: recovery.id },
        data: { customerId: customer.id },
      });
    }

    if (recovery.status !== "DETECTED") {
      if (recovery.status === "MESSAGE_SENT" || recovery.status === "ENGAGED") {
        await this.finalizationService.ensureScheduledInitialFollowUp(recovery.id);
      }
      return recovery;
    }

    const policy = await recoveryPolicyService.resolve(recovery.shopId);
    const attempt = await recoveryOutreachAttemptService.getOrCreate({
      recoveryId: recovery.id,
      sequence: 1,
      policy,
    });
    const recipient = this.ports!.resolveRecipient(event);
    const selection = await whatsappTemplateSelectorService.select({
      shopId: recovery.shopId,
      providerAccountId: outboundWhatsAppAdmissionService.getProviderAccountId(),
      purpose: "checkout-recovery",
      languageTag: null,
      countryCode: event.internationalContext?.countryCode ?? null,
      resolveMarketCapability: async () => "unknown" as const,
    });

    if (selection.outcome !== "selected" && selection.outcome !== "provider-check-required") {
      return recovery;
    }

    let billing = await this.billingService.admit({
      shopId: recovery.shopId,
      recoveryId: recovery.id,
      outreachAttemptId: attempt.id,
    });
    if (billing.kind === "blocked") {
      if (billing.reason === "capacity-exhausted") {
        await this.ports!.markRecoveryCapacityBlocked(recovery.id);
        await recoveryOutreachAttemptService.markStatus(attempt.id, "CAPACITY_BLOCKED");
      }
      return recovery;
    }

    const content = conversationMessageService.buildRecoveryTemplateDescriptor({
      purpose: "checkout-recovery",
      templateName: selection.providerTemplateName,
      canonicalLanguageTag: selection.canonicalLanguageTag,
      providerLanguageCode: selection.providerLanguageCode,
    });

    let conversation;
    try {
      conversation = await conversationService.getOrCreateRecoveryConversation(
        recovery.id,
        event.internationalContext,
      );
    } catch (error) {
      await this.billingService.releaseBeforeProvider(billing.admission);
      throw error;
    }

    let result;
    try {
      const revalidated = await this.billingService.revalidateBeforeProvider({
        admission: billing.admission,
        recoveryId: recovery.id,
        outreachAttemptId: attempt.id,
      });
      if (revalidated.kind === "blocked") {
        await recoveryOutreachAttemptService.markStatus(attempt.id, "CAPACITY_BLOCKED", {
          failureCode: revalidated.reason,
        });
        return recovery;
      }
      billing = revalidated;
      result = await outboundWhatsAppAdmissionService.sendTemplate({
        shopId: recovery.shopId,
        conversationId: conversation.id,
        idempotencyKey: `recovery-outreach:${attempt.id}`,
        recoveryCreditSourceKey: billing.admission.sourceKey,
        senderType: "AUTOMATION",
        content,
        to: recipient,
        templateName: selection.providerTemplateName,
        languageCode: selection.providerLanguageCode,
      });
    } catch (error) {
      await this.billingService.handleProviderFailure({ admission: billing.admission, error });
      await recoveryOutreachAttemptService.markStatus(attempt.id, "FAILED", {
        failureCode: "PROVIDER_FAILURE",
      });
      throw error;
    }

    if (result.kind === "suppressed") {
      if (result.reason === "duplicate") {
        const existing = await outboundWhatsAppAdmissionService.findExistingAdmission(`recovery-outreach:${attempt.id}`);
        if (existing?.status === "SENT" || existing?.status === "DELIVERED" || existing?.status === "READ") {
          this.finalizationService.requireConfirmedMessage(existing, conversation.id, attempt.id);
          await this.finalizationService.finalizeConfirmedOutreach({
            recovery,
            attempt,
            admission: billing.admission,
            message: existing,
            policy,
          });
          return recovery;
        }
        if (existing?.status === "PENDING") {
          throw new Error(`Recovery outreach send is still pending for attempt ${attempt.id}`);
        }
        if (!existing) {
          throw new Error(`Recovery outreach admission has no durable message for attempt ${attempt.id}`);
        }
      }
      await this.billingService.releaseBeforeProvider(billing.admission);
      await recoveryOutreachAttemptService.markStatus(attempt.id, "FAILED", {
        failureCode: result.reason,
      });
      return recovery;
    }

    const persistedMessage = await outboundWhatsAppAdmissionService.findExistingAdmission(`recovery-outreach:${attempt.id}`);
    this.finalizationService.requireConfirmedMessage(persistedMessage, conversation.id, attempt.id);
    await this.finalizationService.finalizeConfirmedOutreach({
      recovery,
      attempt,
      admission: billing.admission,
      message: persistedMessage,
      policy,
    });
    return recovery;
  }
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}