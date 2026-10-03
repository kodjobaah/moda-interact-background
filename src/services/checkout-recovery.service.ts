import { loadCommerceHistory } from "../commerce/history.js";
// src/services/checkout-recovery.service.ts

import prisma from "../lib/db.js";
import type { RecoveryCheckoutSeed } from "../events/checkout-events.js";
import type {
  CheckoutCreatedContractInput,
  CartActivityContractInput,
  CheckoutUpdatedContractInput,
  OrderCompletedContractInput,
} from "../events/shopify-contract-adapter.js";
import { conversationService } from "./conversation.service.js";
import { conversationMessageService } from "./conversation.message.service.js";
import { outboundWhatsAppAdmissionService } from "./outbound-whatsapp-admission.service.js";
import { whatsappTemplateSelectorService } from "./whatsapp-template-selector.service.js";
import {
  recoveryBillingService,
  type RecoveryBillingService,
} from "./recovery-billing.service.js";
import { pendingRecoveryCandidateService } from "./pending-recovery-candidate.service.js";
import { recoveryPolicyService } from "./recovery-policy.service.js";
import { recoveryOutreachAttemptService } from "./recovery-outreach-attempt.service.js";
import { shopExecutionEligibilityService } from "./shop-execution-eligibility.service.js";
import { abandonedCheckoutLookupService } from "./abandoned-checkout-lookup.service.js";
import { findLatestRecovery } from "./checkout-recovery/latest-recovery.js";
import { RecoveryInitiationService } from "./checkout-recovery/recovery-initiation.service.js";
import { RecoveryOutreachFinalizationService } from "./checkout-recovery/recovery-outreach-finalization.service.js";
import { RecoveryOutreachFollowUpProcessorService } from "./checkout-recovery/recovery-outreach-follow-up-processor.service.js";
import { recoverySnapshotBuilderService } from "./checkout-recovery/recovery-snapshot-builder.service.js";
import { RecoveryMaterializationService } from "./checkout-recovery/recovery-materialization.service.js";
import type { MaturedCandidateMaterializationResult } from "./checkout-recovery/recovery-materialization.service.js";
export type { MaturedCandidateMaterializationResult } from "./checkout-recovery/recovery-materialization.service.js";
import type { PendingRecoveryCandidate } from "../domain/pending-recovery-candidate.js";
import type { AgentMessage, RecoveryAgentContext } from "../agents/types.js";
import { CheckoutEventOrchestratorService } from "./checkout-recovery/checkout-event-orchestrator.service.js";
import type { CheckoutRefreshResult } from "./checkout-recovery/checkout-event-orchestrator.service.js";
export type { CheckoutRefreshResult } from "./checkout-recovery/checkout-event-orchestrator.service.js";
import { OrderRecoveryCorrelationService } from "./checkout-recovery/order-recovery-correlation.service.js";
import type { RecoveryOrderCompletionInput } from "./checkout-recovery/order-recovery-correlation.service.js";
import { RecoveryCapacityResumeProcessorService } from "./checkout-recovery/recovery-capacity-resume-processor.service.js";

export class CheckoutRecoveryService {
  private readonly initiationService: RecoveryInitiationService;
  private readonly finalizationService: RecoveryOutreachFinalizationService;
  private readonly followUpProcessorService: RecoveryOutreachFollowUpProcessorService;
  private readonly snapshotBuilderService = recoverySnapshotBuilderService;
  private readonly materializationService: RecoveryMaterializationService;
  private readonly checkoutEventOrchestrator: CheckoutEventOrchestratorService;
  private readonly orderRecoveryCorrelationService: OrderRecoveryCorrelationService;
  private readonly capacityResumeProcessorService: RecoveryCapacityResumeProcessorService;

  constructor(
    private readonly billingService: RecoveryBillingService = recoveryBillingService,
  ) {
    this.finalizationService = new RecoveryOutreachFinalizationService(this.billingService);
    this.followUpProcessorService = new RecoveryOutreachFollowUpProcessorService(
      this.billingService,
      this.finalizationService,
    );
    this.initiationService = new RecoveryInitiationService(
      this.billingService,
      this.finalizationService,
      {
        upsertRecovery: (event, generation) => this.upsertRecovery(event, generation),
        resolveRecipient: (event) => this.resolveRecipient(event),
        markRecoveryCapacityBlocked: (recoveryId) => this.markRecoveryCapacityBlocked(recoveryId),
      },
    );
    this.materializationService = new RecoveryMaterializationService({
      executionEligibility: shopExecutionEligibilityService,
      abandonedCheckoutLookup: abandonedCheckoutLookupService,
      pendingRecoveryCandidate: pendingRecoveryCandidateService,
      findLatestRecovery,
      snapshotBuilder: this.snapshotBuilderService,
      initiate: (seed, generation) => generation === undefined
        ? this.handleCheckoutCreated(seed)
        : this.handleCheckoutCreated(seed, generation),
    });
    this.checkoutEventOrchestrator = new CheckoutEventOrchestratorService(
      prisma,
      pendingRecoveryCandidateService,
      shopExecutionEligibilityService,
      findLatestRecovery,
      abandonedCheckoutLookupService,
      this.snapshotBuilderService,
    );
    this.orderRecoveryCorrelationService = new OrderRecoveryCorrelationService(
      prisma,
      pendingRecoveryCandidateService,
    );
    this.capacityResumeProcessorService = new RecoveryCapacityResumeProcessorService(
      prisma,
      pendingRecoveryCandidateService,
      shopExecutionEligibilityService,
      abandonedCheckoutLookupService,
      this.snapshotBuilderService,
      (seed, generation) => generation === undefined
        ? this.handleCheckoutCreated(seed)
        : this.handleCheckoutCreated(seed, generation),
    );
  }

  async handleCheckoutCreatedContract(event: CheckoutCreatedContractInput) {
    return this.checkoutEventOrchestrator.handleCheckoutCreatedContract(event);
  }

  async materializeMaturedCandidate(
    candidate: PendingRecoveryCandidate,
  ): Promise<MaturedCandidateMaterializationResult> {
    return this.materializationService.materialize(candidate);
  }

  async recordExternalActivity(recoveryId: string, activityAt: Date) {
    return this.checkoutEventOrchestrator.recordExternalActivity(recoveryId, activityAt);
  }

  async handleCheckoutUpdatedContract(
    event: CheckoutUpdatedContractInput,
  ): Promise<CheckoutRefreshResult> {
    return this.checkoutEventOrchestrator.handleCheckoutUpdatedContract(event);
  }

  async handleCartActivityContract(event: CartActivityContractInput) {
    return this.checkoutEventOrchestrator.handleCartActivityContract(event);
  }

  async handleOrderCompletedContract(event: OrderCompletedContractInput) {
    return this.handleOrderCompleted({
      shop: event.shopDomain,
      orderId: event.orderId,
      checkoutToken: event.checkoutToken,
      cartToken: event.cartToken,
      customerId: null,
      totalPrice: null,
      currency: null,
      completedAt: event.completedAt,
    });
  }

  async upsertRecovery(event: RecoveryCheckoutSeed, generation = 1) {
    return this.initiationService.upsertRecovery(event, generation);
  }

  async attachCustomer(recoveryId: string, customerId: string) {
    return this.initiationService.attachCustomer(recoveryId, customerId);
  }

  resolveRecipient(event: RecoveryCheckoutSeed): string {
    return this.initiationService.resolveRecipient(event);
  }

  async markRecoveryMessageSent(recoveryId: string) {
    return this.initiationService.markRecoveryMessageSent(recoveryId);
  }

  /*
   * ARCH-001-BACKGROUND-005.
   *
   * Orders are only ever processed for recovery purposes:
   *   1. a matching pending candidate is cancelled (and its aliases cleaned up);
   *   2. else a matching existing CheckoutRecovery is completed/attributed;
   *   3. else the order is discarded.
   *
   * The order path serialises against candidate materialization on a single
   * checkout via a transient Redis mutex plus an order-completion tombstone, so
   * an order that completes a checkout before a recovery message is committed
   * never triggers an inappropriate recovery message. No durable order record
   * or retained business event is created for an unrelated order.
   */
  async handleOrderCompleted(event: RecoveryOrderCompletionInput) {
    return this.orderRecoveryCorrelationService.handleOrderCompleted(event);
  }

  async handleCheckoutCreated(event: RecoveryCheckoutSeed, generation = 1) {
    return this.initiationService.handleCheckoutCreated(event, generation);
  }

  async processRecoveryOutreachFollowUp(recoveryId: string) {
    return this.followUpProcessorService.process(recoveryId);
  }

  async markRecoveryCapacityBlocked(recoveryId: string, blockedAt = new Date()) {
    return this.initiationService.markRecoveryCapacityBlocked(recoveryId, blockedAt);
  }

  async resumeCapacityBlockedRecovery(recoveryId: string) {
    return this.capacityResumeProcessorService.resume(recoveryId);
  }

  async getAgentContext({
    checkoutRecoveryId,
    conversationId,
    pendingTurnStartedAt,
  }: {
    checkoutRecoveryId: string;
    conversationId: string;
    pendingTurnStartedAt?: Date | null;
  }): Promise<RecoveryAgentContext> {
    const recovery = await prisma.checkoutRecovery.findUnique({
      where: {
        id: checkoutRecoveryId,
      },

      select: {
        id: true,
        shopId: true,
        shop: {
          select: {
            domain: true,
          },
        },
        status: true,
        checkoutToken: true,
        completedAt: true,
        totalPrice: true,

        customer: {
          select: {
            id: true,
            phone: true,
            firstName: true,
          },
        },

        conversation: {
          where: {
            id: conversationId,
          },

          take: 1,

          select: {
            id: true,
            type: true,
            summary: true,
            inboundVersion: true,
            languageTag: true,
            languageSource: true,
          },
        },
      },
    });

    if (!recovery) {
      throw new Error(`Checkout recovery not found: ${checkoutRecoveryId}`);
    }

    const conversation = recovery.conversation;

    if (!conversation) {
      throw new Error(
        `Conversation ${conversationId} does not belong to recovery ${checkoutRecoveryId}`,
      );
    }

    const bounded = await loadCommerceHistory(conversationId, pendingTurnStartedAt ?? new Date());
    const messages = bounded.currentMessages;

    return {
      shopId: recovery.shopId,
      shop: recovery.shop.domain,

      recovery: {
        id: recovery.id,

        status: recovery.status,

        checkoutToken: recovery.checkoutToken,

        completedAt: recovery.completedAt,

        totalPrice: recovery.totalPrice?.toString() ?? null,
      },

      customer: recovery.customer
        ? {
            id: recovery.customer.id,

            phone: recovery.customer.phone,

            firstName: recovery.customer.firstName,
          }
        : null,

      conversation: {
        conversationId: conversation.id,

        shop: recovery.shop.domain,

        type: conversation.type,

        summary: conversation.summary,

        version: conversation.inboundVersion,

        languageTag: conversation.languageTag,

        languageSource: conversation.languageSource
          ? (conversation.languageSource
              .toLowerCase()
              .replaceAll("_", "-") as NonNullable<
              RecoveryAgentContext["conversation"]["languageSource"]
            >)
          : null,

        messages,
        history: bounded.history,
        oversized: bounded.oversized,
      },
    };
  }

  async getAgentContextForStandaloneConversation({
    checkoutRecoveryId,
    conversationId,
    pendingTurnStartedAt,
  }: {
    checkoutRecoveryId: string;
    conversationId: string;
    pendingTurnStartedAt?: Date | null;
  }): Promise<RecoveryAgentContext> {
    const recovery = await prisma.checkoutRecovery.findUnique({
      where: { id: checkoutRecoveryId },
      select: {
        id: true,
        shopId: true,
        shop: { select: { domain: true } },
        status: true,
        checkoutToken: true,
        completedAt: true,
        totalPrice: true,
        customer: {
          select: { id: true, phone: true, firstName: true },
        },
      },
    });

    if (!recovery) {
      throw new Error(`Checkout recovery not found: ${checkoutRecoveryId}`);
    }

    const conversation = await conversationService.getAgentSnapshot(
      conversationId,
      pendingTurnStartedAt,
    );

    return {
      shopId: recovery.shopId,
      shop: recovery.shop.domain,
      recovery: {
        id: recovery.id,
        status: recovery.status,
        checkoutToken: recovery.checkoutToken,
        completedAt: recovery.completedAt,
        totalPrice: recovery.totalPrice?.toString() ?? null,
      },
      customer: recovery.customer
        ? {
            id: recovery.customer.id,
            phone: recovery.customer.phone,
            firstName: recovery.customer.firstName,
          }
        : null,
      conversation: {
        ...conversation,
        shop: recovery.shop.domain,
      },
    };
  }
}

export const checkoutRecoveryService = new CheckoutRecoveryService();

function safelyNormalize(
  value: string | null | undefined,
  normalizer: (value: string) => string,
): string | null {
  if (!value?.trim()) return null;

  try {
    return normalizer(value);
  } catch {
    return null;
  }
}
