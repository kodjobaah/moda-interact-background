// src/services/checkout-recovery.service.ts

import prisma from "../lib/db.js";
import { loadCommerceHistory } from "../commerce/history.js";
import type { RecoveryCheckoutSeed } from "../events/checkout-events.js";
import type {
  CheckoutCreatedContractInput,
  CartActivityContractInput,
  CheckoutUpdatedContractInput,
  OrderCompletedContractInput,
} from "../events/shopify-contract-adapter.js";
import { conversationService } from "./conversation.service.js";
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
import { recoveryRecipientResolverService } from "./checkout-recovery/recovery-recipient-resolver.service.js";
import type { MaturedCandidateMaterializationResult } from "./checkout-recovery/recovery-materialization.service.js";
export type { MaturedCandidateMaterializationResult } from "./checkout-recovery/recovery-materialization.service.js";
import type { PendingRecoveryCandidate } from "../domain/pending-recovery-candidate.js";
import type { RecoveryAgentContext } from "../agents/types.js";
import { CheckoutEventOrchestratorService } from "./checkout-recovery/checkout-event-orchestrator.service.js";
import type { CheckoutRefreshResult } from "./checkout-recovery/checkout-event-orchestrator.service.js";
export type { CheckoutRefreshResult } from "./checkout-recovery/checkout-event-orchestrator.service.js";
import { OrderRecoveryCorrelationService } from "./checkout-recovery/order-recovery-correlation.service.js";
import type { RecoveryOrderCompletionInput } from "./checkout-recovery/order-recovery-correlation.service.js";
import { RecoveryCapacityResumeProcessorService } from "./checkout-recovery/recovery-capacity-resume-processor.service.js";
import { RecoveryAgentContextService } from "./checkout-recovery/recovery-agent-context.service.js";
import type { RecoveryAgentContextInput } from "./checkout-recovery/recovery-agent-context.service.js";

export class CheckoutRecoveryService {
  private readonly initiationService: RecoveryInitiationService;
  private readonly finalizationService: RecoveryOutreachFinalizationService;
  private readonly followUpProcessorService: RecoveryOutreachFollowUpProcessorService;
  private readonly snapshotBuilderService = recoverySnapshotBuilderService;
  private readonly materializationService: RecoveryMaterializationService;
  private readonly checkoutEventOrchestrator: CheckoutEventOrchestratorService;
  private readonly orderRecoveryCorrelationService: OrderRecoveryCorrelationService;
  private readonly capacityResumeProcessorService: RecoveryCapacityResumeProcessorService;
  private readonly recoveryAgentContextService: RecoveryAgentContextService;

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
      recipientResolver: recoveryRecipientResolverService,
      initiate: (seed, generation, recipient) => this.handleCheckoutCreated(seed, generation, recipient),
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
    this.recoveryAgentContextService = new RecoveryAgentContextService(
      prisma,
      conversationService,
      loadCommerceHistory,
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

  async handleCheckoutCreated(event: RecoveryCheckoutSeed, generation = 1, resolvedRecipient?: string) {
    return this.initiationService.handleCheckoutCreated(event, generation, resolvedRecipient);
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

  async getAgentContext(input: RecoveryAgentContextInput): Promise<RecoveryAgentContext> {
    return this.recoveryAgentContextService.getAgentContext(input);
  }

  async getAgentContextForStandaloneConversation(input: RecoveryAgentContextInput): Promise<RecoveryAgentContext> {
    return this.recoveryAgentContextService.getAgentContextForStandaloneConversation(input);
  }
}

export const checkoutRecoveryService = new CheckoutRecoveryService();
