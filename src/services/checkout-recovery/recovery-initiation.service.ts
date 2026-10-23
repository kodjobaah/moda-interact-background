import { Prisma } from "@prisma/client";
import type { RecoveryCheckoutSeed } from "../../events/checkout-events.js";
import prisma from "../../lib/db.js";
import { recoveryShopifyCustomerService } from "./recovery-shopify-customer.service.js";
import { conversationService } from "../conversation.service.js";
import { conversationMessageService } from "../conversation.message.service.js";
import { outboundWhatsAppAdmissionService } from "../outbound-whatsapp-admission.service.js";
import { isSynchronousRecipientFailure } from "../whatsapp-provider-rejection.js";
import { whatsappTemplateSelectorService } from "../whatsapp-template-selector.service.js";
import { metaWhatsAppTemplateCategoryService } from "../whatsapp-template-category.service.js";
import {
  recoveryBillingService,
  type RecoveryBillingService,
} from "../recovery-billing.service.js";
import { recoveryPolicyService } from "../recovery-policy.service.js";
import { recoveryOutreachAttemptService } from "../recovery-outreach-attempt.service.js";
import { findLatestRecovery } from "./latest-recovery.js";
import {
  recoveryConsentAdmissionService,
  type RecoveryConsentAdmissionPort,
} from "./recovery-consent-admission.service.js";
import { RecoveryOutreachFinalizationService } from "./recovery-outreach-finalization.service.js";
import { canonicalizeRecoveryRecipient } from "./recovery-recipient-canonicalization.js";
import {
  recoveryRecipientSuppressionAdmissionService,
  type RecoveryRecipientSuppressionAdmissionService,
} from "./recovery-recipient-suppression-admission.service.js";

type Recovery = NonNullable<Awaited<ReturnType<typeof prisma.checkoutRecovery.findFirst>>>;

interface RecoveryInitiationPorts {
  upsertRecovery: (event: RecoveryCheckoutSeed, generation: number) => Promise<Recovery | null>;
  resolveRecipient: (event: RecoveryCheckoutSeed) => string;
  markRecoveryCapacityBlocked: (recoveryId: string) => Promise<unknown>;
}

export type RecoveryAdmissionGate = () => Promise<boolean>;

export class RecoveryInitiationService {
  constructor(
    private readonly billingService: RecoveryBillingService = recoveryBillingService,
    private readonly finalizationService: RecoveryOutreachFinalizationService = new RecoveryOutreachFinalizationService(billingService),
    private readonly ports?: RecoveryInitiationPorts,
    private readonly suppressionAdmission: RecoveryRecipientSuppressionAdmissionService = recoveryRecipientSuppressionAdmissionService,
    private readonly consentAdmission: RecoveryConsentAdmissionPort = recoveryConsentAdmissionService,
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
    if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
      throw new Error("TEST_WHATSAPP_RECIPIENT is only available in development or test");
    }
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

  async handleCheckoutCreated(
    event: RecoveryCheckoutSeed,
    generation = 1,
    resolvedRecipient?: string,
    suppressionWakeupTrigger?: string,
    admissionGate?: RecoveryAdmissionGate,
  ) {
    // Verify native Shopify permission BEFORE the first CheckoutRecovery INSERT.
    // The candidate worker has already checked the checkout/order lifecycle under
    // its checkout lock. Direct initiation must also reject completed checkouts.
    if (event.completedAt) return null;
    const shop = await prisma.shop.findUniqueOrThrow({
      where: { domain: event.shop }, select: { id: true },
    });
    const previous = await findLatestRecovery(shop.id, event.checkoutToken);
    const requiresAdmission = !previous || previous.status === "DETECTED" || previous.status === "EXPIRED";
    let customer: Awaited<ReturnType<typeof recoveryShopifyCustomerService.resolve>> | undefined;
    let recipient: string | null = null;
    if (requiresAdmission) {
      customer = await recoveryShopifyCustomerService.resolve(event, shop.id);
      let sourceRecipient = resolvedRecipient ?? event.customer?.phone;
      if (!sourceRecipient) {
        // Do not fall back to a test-only recipient for real customer consent.
        sourceRecipient = null;
      }
      recipient = canonicalizeRecoveryRecipient(sourceRecipient);
      const identity = customer?.id ?? previous?.customerId ?? null;
      const permitted = previous
        ? await this.consentAdmission.evaluateReentry({
            shopId: shop.id, checkoutToken: event.checkoutToken,
            customerId: identity, recipient,
          })
        : await this.consentAdmission.evaluateFirst({
            shopId: shop.id, checkoutToken: event.checkoutToken,
            customerId: identity,
            shopifyCustomerId: event.customer?.shopifyCustomerId ?? null,
            recipient,
          });
      if (!permitted) return null;

      if (!previous && recipient) {
        // Temporary provider reachability is distinct from consent. Do not leave
        // a DETECTED row waiting for reachability on first admission.
        const initialSuppression = await this.suppressionAdmission.evaluate(shop.id, recipient);
        if (initialSuppression.kind === "suppressed") return null;
      }
    }

    let recovery = await this.ports!.upsertRecovery(event, generation);
    if (!recovery) {
      throw new Error(`Recovery generation was not materialized for ${event.checkoutToken}`);
    }

    if (customer === undefined) customer = await recoveryShopifyCustomerService.resolve(event, shop.id);
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
    recipient ??= canonicalizeRecoveryRecipient(resolvedRecipient ?? this.ports!.resolveRecipient(event));
    if (!recipient) {
      await this.consentAdmission.notifyMissingRecipient({ shopId: recovery.shopId, checkoutToken: event.checkoutToken });
      return recovery;
    }
    // First-send re-entries (including legacy DETECTED and capacity/suppression
    // wakeups) use current stored CustomerPhone permission, never Shopify GraphQL.
    // Also close the gap between a new checkout's remote read and its row insert.
    const currentlyAllowed = await this.consentAdmission.evaluateReentry({
      shopId: recovery.shopId,
      checkoutToken: event.checkoutToken,
      customerId: customer?.id ?? recovery.customerId,
      recipient,
    });
    if (!currentlyAllowed) return recovery;
    const suppression = await this.suppressionAdmission.evaluate(recovery.shopId, recipient);
    if (suppression.kind === "suppressed") {
      await this.suppressionAdmission.deferDetectedRecovery(
        recovery.id,
        recovery.shopId,
        suppression.until,
        suppressionWakeupTrigger,
      );
      return recovery;
    }
    if (recovery.admissionBlockReason === "WHATSAPP_RECIPIENT_SUPPRESSED") {
      await this.suppressionAdmission.clearDetectedSuppression(recovery.id);
    }

    if (admissionGate && !(await admissionGate())) return recovery;

    const selection = await whatsappTemplateSelectorService.select({
      shopId: recovery.shopId,
      providerAccountId: await outboundWhatsAppAdmissionService.getProviderAccountId(),
      purpose: "checkout-recovery",
      languageTag: null,
      countryCode: event.internationalContext?.countryCode ?? null,
      resolveMarketCapability: async () => "unknown" as const,
      verifyCategory: (query) => metaWhatsAppTemplateCategoryService.verify(query),
    });

    if (selection.outcome !== "selected" && selection.outcome !== "provider-check-required") {
      return recovery;
    }
    // Approval/purpose alone never prove Marketing: the selector asks Meta for
    // the exact account, name, language and (when known) template ID.
    if (selection.verifiedCategory !== "MARKETING") {
      return recovery;
    }

    const attempt = await recoveryOutreachAttemptService.getOrCreate({
      recoveryId: recovery.id,
      sequence: 1,
      policy,
      recipient,
    });

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

    // Narrow the first-send window once more before provider admission. This
    // stored-only check does not substitute for BACKGROUND-004's final SQL fence.
    let finalConsentAllowed: boolean;
    try {
      finalConsentAllowed = await this.consentAdmission.evaluateReentry({
        shopId: recovery.shopId,
        checkoutToken: event.checkoutToken,
        customerId: customer?.id ?? recovery.customerId,
        recipient: attempt.recipient,
      });
    } catch (error) {
      await this.billingService.releaseBeforeProvider(billing.admission);
      throw error;
    }
    if (!finalConsentAllowed) {
      await this.billingService.releaseBeforeProvider(billing.admission);
      await recoveryOutreachAttemptService.markStatus(attempt.id, "FAILED", {
        failureCode: "CONSENT_BLOCKED",
      });
      return recovery;
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
        to: attempt.recipient,
        templateName: selection.providerTemplateName,
        languageCode: selection.providerLanguageCode,
      });
    } catch (error) {
      // The exact 131026 message, attempt and credit were already reconciled
      // at the provider boundary. Never reclassify or overwrite that evidence.
      if (!isSynchronousRecipientFailure(error)) {
        await this.billingService.handleProviderFailure({ admission: billing.admission, error });
        await recoveryOutreachAttemptService.markStatus(attempt.id, "FAILED", {
          failureCode: "PROVIDER_FAILURE",
        });
      }
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
        if (existing?.status === "FAILED") {
          // Synchronous 131026 remains a consumed attempt after the hard-limit
          // usage row is corrected; do not overwrite its terminal evidence.
          await this.billingService.releaseBeforeProvider(billing.admission);
          return recovery;
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