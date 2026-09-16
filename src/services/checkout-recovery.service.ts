// src/services/checkout-recovery.service.ts

import prisma from "../lib/db.js";
import type { RecoveryCheckoutSeed } from "../events/checkout-events.js";
import { Prisma } from "@prisma/client";
import type {
  CheckoutCreatedContractInput,
  CartActivityContractInput,
  CheckoutUpdatedContractInput,
  OrderCompletedContractInput,
} from "../events/shopify-contract-adapter.js";
import { customerService } from "./customer.service.js";
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
import { recoveryOutreachFollowUpService } from "./recovery-outreach-follow-up.service.js";
import {
  shopExecutionEligibilityService,
  type ShopExecutionDenialReason,
} from "./shop-execution-eligibility.service.js";
import { abandonedCheckoutLookupService } from "./abandoned-checkout-lookup.service.js";
import {
  toLookupInput,
  type AbandonedCheckoutLookupInput,
  type NormalizedAbandonedCheckout,
} from "../domain/abandoned-checkout.js";
import type { PendingRecoveryCandidate } from "../domain/pending-recovery-candidate.js";
import type { AgentMessage, RecoveryAgentContext } from "../agents/types.js";
import {
  canonicaliseLanguageTag,
  normalizeCountryCode,
  normalizeTimeZone,
  type InternationalContext,
} from "@modainteract/moda-interact-shared/internationalization";

interface RecoveryOrderCompletionInput {
  shop: string;
  orderId: string;
  checkoutToken: string | null;
  cartToken: string | null;
  customerId: string | null;
  totalPrice: string | null;
  currency: string | null;
  completedAt: string | null;
}

export type MaturedCandidateMaterializationResult =
  | { outcome: "recovery-created"; checkoutToken: string }
  | { outcome: "no-op-existing"; checkoutToken: string; status: string }
  | { outcome: "discarded-terminal"; checkoutToken: string; status: string }
  | { outcome: "discarded-not-found"; checkoutToken: string }
  | { outcome: "discarded-not-recoverable"; checkoutToken: string }
  | { outcome: "discarded-ambiguous"; checkoutToken: string }
  | { outcome: "discarded-bound-exceeded"; checkoutToken: string }
  | { outcome: "discarded-order-completed"; checkoutToken: string }
  | {
      outcome: "discarded-shop-unavailable";
      checkoutToken: string;
      reason?: "CONTRACT_REQUIRED" | "SUBSCRIPTION_FROZEN" | "SHOP_UNAVAILABLE" | "UNMAPPED_PLAN" | "SYNC_ERROR";
    };

export type CheckoutRefreshResult =
  | { kind: "pending"; outcome: string; jobId?: string }
  | { kind: "refreshed"; recoveryId: string; status: string }
  | { kind: "discarded"; reason: string }
  | { kind: "ignored"; reason: string };

export class CheckoutRecoveryService {
  constructor(
    private readonly billingService: RecoveryBillingService = recoveryBillingService,
  ) {}

  async handleCheckoutCreatedContract(event: CheckoutCreatedContractInput) {
    const scheduled =
      await pendingRecoveryCandidateService.scheduleFromCheckoutCreated(event);

    if (scheduled.outcome === "discarded-shop-unavailable") {
      return {
        kind: "ignored",
        reason: "shop-unavailable",
        shopDomain: scheduled.shopDomain,
        checkoutToken: event.checkoutToken,
        source: "v2",
      } as const;
    }
    if (scheduled.outcome === "discarded-subscription-frozen") {
      return {
        kind: "ignored",
        reason: "subscription-frozen",
        shopDomain: scheduled.shopDomain,
        checkoutToken: event.checkoutToken,
        source: "v2",
      } as const;
    }

    return {
      kind: "scheduled",
      outcome: scheduled.outcome,
      delayMinutes: scheduled.delayMinutes,
      shopDomain: event.shopDomain,
      checkoutToken: event.checkoutToken,
      source: "v2",
    } as const;
  }

  /**
   * Transition a matured pending candidate into durable `CheckoutRecovery`.
   *
   * ARCH-001-BACKGROUND-004. The webhook's embedded basket/customer payload is
   * never used here. Current Shopify data (from ARCH-001-BACKGROUND-003) is the
   * only source used to populate recovery state. Non-recoverable outcomes
   * (not-found, ambiguous, bound-exceeded, already-completed) produce no
   * recovery record and no message.
   */
  async materializeMaturedCandidate(
    candidate: PendingRecoveryCandidate,
  ): Promise<MaturedCandidateMaterializationResult> {
    const execution = await shopExecutionEligibilityService.evaluate(candidate.shopId);
    if (!execution.allowed) {
      return {
        outcome: "discarded-shop-unavailable",
        checkoutToken: candidate.checkoutToken,
        ...(execution.reason !== "SHOP_UNAVAILABLE"
          ? { reason: execution.reason }
          : {}),
      } as const;
    }
    const shopDomain = await abandonedCheckoutLookupService.resolveShopDomain(
      candidate.shopId,
    );

    // Checkout-scoped serialization with the order path (ARCH-001-BACKGROUND-005).
    return pendingRecoveryCandidateService.withCheckoutLock(
      candidate.shopId,
      candidate.checkoutToken,
      async () => {
        const lockedExecution = await shopExecutionEligibilityService.evaluate(
          candidate.shopId,
        );
        if (!lockedExecution.allowed) {
          return {
            outcome: "discarded-shop-unavailable",
            checkoutToken: candidate.checkoutToken,
            ...(lockedExecution.reason !== "SHOP_UNAVAILABLE"
              ? { reason: lockedExecution.reason }
              : {}),
          } as const;
        }

        // If an order already processed this checkout, the checkout completed
        // before recovery action was committed: do not create a recovery or
        // send a recovery message for it.
        if (
          await pendingRecoveryCandidateService.hasOrderProcessed(
            candidate.shopId,
            candidate.checkoutToken,
          )
        ) {
          return {
            outcome: "discarded-order-completed",
            checkoutToken: candidate.checkoutToken,
          } as const;
        }

        const existing = await this.findLatestRecovery(
          candidate.shopId,
          candidate.checkoutToken,
        );
        let generation = 1;
        if (existing) {
          if (["DETECTED", "MESSAGE_SENT", "ENGAGED"].includes(existing.status)) {
            return {
              outcome: "no-op-existing",
              checkoutToken: candidate.checkoutToken,
              status: existing.status,
            } as const;
          }
          if (["COMPLETED", "CANCELLED"].includes(existing.status)) {
            return {
              outcome: "discarded-terminal",
              checkoutToken: candidate.checkoutToken,
              status: existing.status,
            } as const;
          }
          generation = existing.generation + 1;
        }

        const outcome = await abandonedCheckoutLookupService.lookup(
          toLookupInput(candidate, shopDomain),
        );

        // Transient Shopify/API failures remain retryable and are never
        // translated into a "not recoverable" decision.
        if (outcome.kind === "provider-error") {
          throw new Error(
            `Abandoned checkout provider error while materializing candidate: ${outcome.message}`,
          );
        }

        if (outcome.kind === "not-found") {
          return {
            outcome: "discarded-not-found",
            checkoutToken: candidate.checkoutToken,
          } as const;
        }

        if (outcome.kind === "ambiguous") {
          return {
            outcome: "discarded-ambiguous",
            checkoutToken: candidate.checkoutToken,
          } as const;
        }

        if (outcome.kind === "bounded-limit-exceeded") {
          return {
            outcome: "discarded-bound-exceeded",
            checkoutToken: candidate.checkoutToken,
          } as const;
        }

        const checkout = outcome.checkout;

        // Shopify reports the checkout already completed: not recoverable.
        if (checkout.completedAt != null) {
          return {
            outcome: "discarded-not-recoverable",
            checkoutToken: candidate.checkoutToken,
          } as const;
        }

        const internationalContext = await this.resolveInternationalContext(
          candidate,
          checkout,
        );
        const seed = this.toRecoverySeed(
          candidate,
          shopDomain,
          checkout,
          internationalContext,
        );
        if (generation === 1) {
          await this.handleCheckoutCreated(seed);
        } else {
          await this.handleCheckoutCreated(seed, generation);
        }

        return {
          outcome: "recovery-created",
          checkoutToken: seed.checkoutToken,
        } as const;
      },
    );
  }

  private async findLatestRecovery(
    shopId: string,
    checkoutToken: string,
  ) {
    return prisma.checkoutRecovery.findFirst({
      where: { shopId, checkoutToken },
      orderBy: [{ generation: "desc" }, { id: "desc" }],
    });
  }

  async recordExternalActivity(recoveryId: string, activityAt: Date) {
    return prisma.checkoutRecovery.updateMany({
      where: {
        id: recoveryId,
        status: { in: ["DETECTED", "MESSAGE_SENT", "ENGAGED"] },
        lastExternalActivityAt: { lt: activityAt },
      },
      data: { lastExternalActivityAt: activityAt },
    });
  }

  /**
   * Map current Shopify data plus candidate correlation identifiers into the
   * existing recovery seed shape. Only the lookup result supplies customer,
   * line item, pricing, currency and recovery URL; the candidate provides only
   * the shopId, checkout token and cart token.
   */
  private toRecoverySeed(
    candidate: PendingRecoveryCandidate,
    shopDomain: string,
    checkout: NormalizedAbandonedCheckout,
    internationalContext: InternationalContext,
  ): RecoveryCheckoutSeed {
    return {
      shop: shopDomain,
      checkoutToken: candidate.checkoutToken,
      cartToken: candidate.cartToken,
      detectedAt:
        checkout.createdAt ||
        candidate.checkoutCreatedAt ||
        new Date().toISOString(),
      ...(candidate.lastActivityAt
        ? { lastExternalActivityAt: candidate.lastActivityAt }
        : {}),
      currency: checkout.currencyCode,
      totalPrice: checkout.totalPrice,
      checkoutUrl: checkout.abandonedCheckoutUrl,
      completedAt: checkout.completedAt,
      internationalContext,
      customer: checkout.customer
        ? {
            shopifyCustomerId: checkout.customer.shopifyCustomerId,
            phone: checkout.customer.phone,
            email: checkout.customer.email,
            firstName: checkout.customer.firstName,
            lastName: checkout.customer.lastName,
          }
        : {
            shopifyCustomerId: null,
            phone: null,
            email: null,
            firstName: null,
            lastName: null,
          },
      lineItems: this.serializeLineItems(checkout.lineItems),
    };
  }

  private async resolveInternationalContext(
    candidate: PendingRecoveryCandidate,
    checkout: NormalizedAbandonedCheckout,
  ): Promise<InternationalContext> {
    const shop = await prisma.shop.findUnique({
      where: { id: candidate.shopId },
      select: {
        settings: {
          select: {
            defaultLanguageTag: true,
            defaultCountryCode: true,
            defaultTimeZone: true,
          },
        },
      },
    });

    const eventContext = candidate.internationalContext;
    const currentContext = checkout.internationalContext ?? {
      languageTag: null,
      languageSource: null,
      countryCode: null,
      currencyCode: null,
      timeZone: null,
    };
    const merchantContext = shop?.settings;
    const languageTag =
      eventContext?.languageTag ??
      currentContext.languageTag ??
      safelyNormalize(
        merchantContext?.defaultLanguageTag,
        canonicaliseLanguageTag,
      );
    const countryCode =
      currentContext.countryCode ??
      eventContext?.countryCode ??
      safelyNormalize(
        merchantContext?.defaultCountryCode,
        normalizeCountryCode,
      );
    const timeZone =
      currentContext.timeZone ??

      eventContext?.timeZone ??
      safelyNormalize(merchantContext?.defaultTimeZone, normalizeTimeZone);

    return {
      languageTag,
      languageSource: languageTag
        ? eventContext?.languageTag || currentContext.languageTag
          ? "shopify"
          : "merchant-default"
        : null,
      countryCode,
      currencyCode:
        currentContext.currencyCode ?? eventContext?.currencyCode ?? null,
      timeZone,
    };
  }

  /**
   * Serialize current Shopify abandoned-checkout line items into the durable
   * recovery snapshot shape. This is the only place that maps normalized line
   * items into the stored `CheckoutRecovery.lineItems` JSON, so creation
   * (BACKGROUND-004) and refresh (BACKGROUND-006) store an identical shape.
   */
  private serializeLineItems(
    lineItems: NormalizedAbandonedCheckout["lineItems"],
  ): RecoveryCheckoutSeed["lineItems"] {
    return lineItems.map((li) => ({
      productId: li.productId,
      variantId: li.variantId,
      title: li.title,
      variantTitle: li.variantTitle,
      sku: li.sku,
      quantity: li.quantity,
      price: li.price,
    }));
  }

  /**
   * Process a checkout-update event by refreshing an existing
   * `CheckoutRecovery` from current Shopify data.
   *
   * ARCH-001-BACKGROUND-006. No `CheckoutRecovery` means the update is
   * discarded immediately: no Shopify lookup and no write beyond the recovery
   * lookup. When a recovery exists, the current Shopify abandoned checkout is
   * re-fetched (BACKGROUND-003) and only basket/content fields are refreshed.
   * The webhook payload is never used as recovery state. Lifecycle status and
   * timing (detectedAt/messageSentAt/engagedAt/completedAt) are preserved: a
   * terminal recovery is never reopened and this task never restarts recovery
   * timing or creates a new recovery.
   */
  async handleCheckoutUpdatedContract(
    event: CheckoutUpdatedContractInput,
  ): Promise<CheckoutRefreshResult> {
    const shop = await prisma.shop.findUnique({
      where: { domain: event.shopDomain },
      select: {
        id: true,
        status: true,
        subscription: { select: { status: true } },
      },
    });
    if (!shop) {
      return { kind: "discarded", reason: "shop-not-found" } as const;
    }
    const execution = shopExecutionEligibilityService.evaluateResolvedShop(shop);
    if (!execution.allowed) {
      return { kind: "ignored", reason: lifecycleReason(execution.reason) } as const;
    }

    const pending =
      await pendingRecoveryCandidateService.refreshCandidateActivity({
        shopId: shop.id,
        checkoutToken: event.checkoutToken,
        cartToken: null,
        activityAt: event.activityAt,
        isEmpty: null,
        ...(event.internationalContext
          ? { internationalContext: event.internationalContext }
          : {}),
      });
    if (pending.outcome !== "not-found") {
      return {
        kind: "pending",
        outcome: pending.outcome,
        ...("jobId" in pending ? { jobId: pending.jobId } : {}),
      };
    }

    const recovery = await this.findLatestRecovery(shop.id, event.checkoutToken);

    // No recovery: the update is irrelevant before recovery exists.
    if (!recovery) {
      return { kind: "discarded", reason: "recovery-not-found" } as const;
    }

    // A terminal recovery is never reopened by a checkout update.
    if (["COMPLETED", "CANCELLED"].includes(recovery.status)) {
      return {
        kind: "ignored",
        reason: `terminal-${recovery.status.toLowerCase()}`,
      } as const;
    }

    if (recovery.status === "EXPIRED") {
      const scheduled = await pendingRecoveryCandidateService.scheduleFromCheckoutUpdated({
        shopDomain: event.shopDomain,
        checkoutToken: event.checkoutToken,
        cartToken: recovery.cartToken,
        checkoutCreatedAt: recovery.detectedAt.toISOString(),
        abandonedCheckoutUrl: recovery.checkoutUrl,
        activityAt: event.activityAt,
        ...(event.internationalContext
          ? { internationalContext: event.internationalContext }
          : {}),
      });
      return {
        kind: "pending",
        outcome: scheduled.outcome,
        ...("jobId" in scheduled ? { jobId: scheduled.jobId } : {}),
      } as const;
    }

    // Fetch the current Shopify abandoned checkout. The lookup input is derived
    // exclusively from durable recovery state (shop/checkout/cart correlation,
    // stored recovery URL, and the Shopify creation timestamp retained in
    // detectedAt), never from the webhook payload.
    const lookupInput: AbandonedCheckoutLookupInput = {
      shopId: shop.id,
      shopDomain: event.shopDomain,
      checkoutToken: event.checkoutToken,
      cartToken: recovery.cartToken,
      abandonedCheckoutUrl: recovery.checkoutUrl,
      checkoutCreatedAt: recovery.detectedAt
        ? recovery.detectedAt.toISOString()
        : null,
    };

      await this.recordExternalActivity(recovery.id, new Date(event.activityAt));

    const outcome = await abandonedCheckoutLookupService.lookup(lookupInput);

    // Transient provider failures remain retryable and are never converted into
    // a "nothing to refresh" discard.
    if (outcome.kind === "provider-error") {
      throw new Error(
        `Abandoned checkout provider error while refreshing recovery ${recovery.id}: ${outcome.message}`,
      );
    }

    if (outcome.kind !== "found") {
      // not-found / ambiguous / bounded-limit-exceeded: the current checkout
      // cannot be identified deterministically, so there is nothing to refresh.
      return {
        kind: "discarded",
        reason: `lookup-${outcome.kind}`,
      } as const;
    }

    const checkout = outcome.checkout;

    // Refresh basket/content fields only. The status-guarded updateMany preserves
    // lifecycle status and prevents refreshing a recovery that concurrently
    // transitioned to a terminal state.
    const refreshed = await prisma.$transaction(async (transaction) => {
      const updated = await transaction.checkoutRecovery.updateMany({
        where: {
          id: recovery.id,
          status: { in: ["DETECTED", "MESSAGE_SENT", "ENGAGED"] },
        },
        data: {
          currency: checkout.currencyCode,
          totalPrice: checkout.totalPrice,
          checkoutUrl: checkout.abandonedCheckoutUrl,
          lineItems: this.serializeLineItems(checkout.lineItems),
        },
      });
      return updated;
    });

    if (refreshed.count === 0) {
      return { kind: "ignored", reason: "already-transitioned" } as const;
    }

    return {
      kind: "refreshed",
      recoveryId: recovery.id,
      status: recovery.status,
    } as const;
  }

  async handleCartActivityContract(event: CartActivityContractInput) {
    const shop = await shopExecutionEligibilityService.resolveShopById(event.shopId);
    if (!shop) {
      return { kind: "ignored", reason: "shop-unavailable" } as const;
    }
    const execution = shopExecutionEligibilityService.evaluateResolvedShop(shop);
    if (!execution.allowed) {
      return { kind: "ignored", reason: lifecycleReason(execution.reason) } as const;
    }
    const result =
      await pendingRecoveryCandidateService.refreshCandidateActivity({
        shopId: event.shopId,
        checkoutToken: null,
        cartToken: event.cartToken,
        activityAt: event.activityAt,
        isEmpty: event.isEmpty,
      });

    return {
      kind: "pending",
      outcome: result.outcome,
      ...("jobId" in result ? { jobId: result.jobId } : {}),
    } as const;
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
        lastExternalActivityAt: new Date(
          event.lastExternalActivityAt ?? event.detectedAt,
        ),

        completedAt:
          event.completedAt !== null ? new Date(event.completedAt) : null,
        },
      });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      return this.findLatestRecovery(shop.id, event.checkoutToken);
    }
  }

  async attachCustomer(recoveryId: string, customerId: string) {
    return prisma.checkoutRecovery.updateMany({
      where: { id: recoveryId, status: "DETECTED" },
      data: {
        customerId,
      },
    });
  }

  resolveRecipient(event: RecoveryCheckoutSeed): string {
    if (event.customer.phone) {
      return event.customer.phone;
    }

    const testRecipient = process.env.TEST_WHATSAPP_RECIPIENT;

    if (!testRecipient) {
      throw new Error(
        "No customer phone and TEST_WHATSAPP_RECIPIENT is not configured",
      );
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
    // Customer identity alone must not associate an order with recovery; we
    // require a checkout/cart correlation identifier.
    if (!event.checkoutToken && !event.cartToken) {
      return { kind: "ignored", reason: "missing-correlation" } as const;
    }

    const shop = await prisma.shop.findUnique({
      where: { domain: event.shop },
      select: { id: true, status: true },
    });

    if (!shop) {
      return { kind: "ignored", reason: "shop-not-found" } as const;
    }
    if (shop.status !== "ACTIVE") {
      return { kind: "ignored", reason: "shop-unavailable" } as const;
    }

    // Cart-only orders must be correlated through the indexed transient
    // candidate correlation before we can determine the checkout scope.
    let checkoutTokenForScope = event.checkoutToken;
    if (!checkoutTokenForScope) {
      const cartOnly = await pendingRecoveryCandidateService.resolveCandidate({
        shopId: shop.id,
        checkoutToken: null,
        cartToken: event.cartToken,
      });

      if (!cartOnly) {
        return { kind: "discarded", reason: "no-checkout-token" } as const;
      }

      checkoutTokenForScope = cartOnly.candidate.checkoutToken;
    }
    return pendingRecoveryCandidateService.withCheckoutLock(
      shop.id,
      checkoutTokenForScope,
      async () => {
        // 1. Resolve a pending candidate (checkout then cart fallback, O(1)).
        const matched = await pendingRecoveryCandidateService.resolveCandidate({
          shopId: shop.id,
          checkoutToken: checkoutTokenForScope,
          cartToken: event.cartToken,
        });

        if (matched) {
          // The checkout completed before recovery began: cancel the candidate
          // and all its aliases, then discard the order.
          await pendingRecoveryCandidateService.cancelCandidate(matched);
          await pendingRecoveryCandidateService.markOrderProcessed(
            shop.id,
            matched.candidate.checkoutToken,
          );
          return {
            kind: "cancelled-candidate",
            checkoutToken: matched.candidate.checkoutToken,
          } as const;
        }

        const checkoutToken = event.checkoutToken as string | null;
        if (!checkoutToken) {
          // No candidate matched, so there is no checkout identity with which
          // to find an existing recovery.
          return { kind: "discarded", reason: "no-checkout-token" } as const;
        }
        // 2. No candidate. Record that an order was processed for this checkout
        //    so an in-flight materialization cannot send a recovery message.
        await pendingRecoveryCandidateService.markOrderProcessed(
          shop.id,
          checkoutToken,
        );

        // 3. Look up and complete the existing recovery if eligible.
        return prisma.$transaction(async (transaction) => {
          const recovery = await transaction.checkoutRecovery.findFirst({
            where: { shopId: shop.id, checkoutToken },
            orderBy: [{ generation: "desc" }, { id: "desc" }],
            select: { id: true, status: true, generation: true },
          });

          if (!recovery) {
            return { kind: "discarded", reason: "recovery-not-found" } as const;
          }

          if (["COMPLETED", "EXPIRED", "CANCELLED"].includes(recovery.status)) {
            return {
              kind: "ignored",
              reason: `terminal-${recovery.status.toLowerCase()}`,
            } as const;
          }

          const completedAt = new Date(
            event.completedAt ?? new Date().toISOString(),
          );

          const updated = await transaction.checkoutRecovery.updateMany({
            where: {
              id: recovery.id,
              status: { in: ["DETECTED", "MESSAGE_SENT", "ENGAGED"] },
            },
            data: {
              status: "COMPLETED",
              completedAt,
              admissionBlockedAt: null,
              admissionBlockReason: null,
            },
          });

          if (updated.count === 0) {
            return { kind: "ignored", reason: "already-transitioned" } as const;
          }

          await transaction.checkoutRecoveryStatusHistory.create({
            data: {
              checkoutRecoveryId: recovery.id,
              fromStatus: recovery.status,
              toStatus: "COMPLETED",
              reason: "Order completed",
              source: "shopify.orders.create",
              metadata: event.customerId
                ? { orderId: event.orderId, customerId: event.customerId }
                : { orderId: event.orderId },
              occurredAt: completedAt,
            },
          });

          return {
            kind: "completed",
            recoveryId: recovery.id,
            fromStatus: recovery.status,
          } as const;
        });
      },
    );
  }

  async handleCheckoutCreated(event: RecoveryCheckoutSeed, generation = 1) {
    // 1
    let recovery = await this.upsertRecovery(event, generation);
    if (!recovery) {
      throw new Error(`Recovery generation was not materialized for ${event.checkoutToken}`);
    }

    // 2
    const customer = await customerService.resolveCustomer(event);

    if (customer && recovery.customerId !== customer.id) {
      recovery = await prisma.checkoutRecovery.update({
        where: {
          id: recovery.id,
        },

        data: {
          customerId: customer.id,
        },
      });
    }

    // Don't send again if this recovery
    // already progressed beyond DETECTED.
    if (recovery.status !== "DETECTED") {
      return recovery;
    }

    const policy = await recoveryPolicyService.resolve(recovery.shopId);
    const attempt = await recoveryOutreachAttemptService.getOrCreate({
      recoveryId: recovery.id,
      sequence: 1,
      policy,
    });

    // 3
    const recipient = this.resolveRecipient(event);

    // 4
    const selection = await whatsappTemplateSelectorService.select({
      shopId: recovery.shopId,
      providerAccountId:
        outboundWhatsAppAdmissionService.getProviderAccountId(),
      purpose: "checkout-recovery",
      languageTag: event.internationalContext?.languageTag ?? null,
      countryCode: event.internationalContext?.countryCode ?? null,
      resolveMarketCapability: async () => "unknown" as const,
    });

    if (
      selection.outcome !== "selected" &&
      selection.outcome !== "provider-check-required"
    ) {
      return recovery;
    }

    let billing = await this.billingService.admit({
      shopId: recovery.shopId,
      recoveryId: recovery.id,
      outreachAttemptId: attempt.id,
    });
    if (billing.kind === "blocked") {
      if (billing.reason === "capacity-exhausted") {
        await this.markRecoveryCapacityBlocked(recovery.id);
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

      // 5b
      result = await outboundWhatsAppAdmissionService.sendTemplate({
        shopId: recovery.shopId,
        conversationId: conversation.id,
        idempotencyKey: `recovery-outreach:${attempt.id}`,
        senderType: "AUTOMATION",
        content,
        to: recipient,
        templateName: selection.providerTemplateName,
        languageCode: selection.providerLanguageCode,
      });
    } catch (error) {
      await this.billingService.handleProviderFailure({
        admission: billing.admission,
        error,
      });
      await recoveryOutreachAttemptService.markStatus(attempt.id, "FAILED", {
        failureCode: "PROVIDER_FAILURE",
      });

      throw error;
    }

    if (result.kind === "suppressed") {
      if (result.reason === "duplicate") {
        const existing = await outboundWhatsAppAdmissionService.findExistingAdmission(`recovery-outreach:${attempt.id}`);
        if (existing?.status === "SENT" || existing?.status === "DELIVERED" || existing?.status === "READ") {
          await this.billingService.commitSuccessfulInitiation({ admission: billing.admission, recoveryId: recovery.id, occurredAt: existing.sentAt ?? new Date() });
          const sentAt = existing.sentAt ?? new Date();
          await recoveryOutreachAttemptService.markWaitingAfterConfirmedSend(attempt.id, { sentAt, outboundMessageId: existing.id });
          return recovery;
        }
        if (existing?.status === "PENDING") return recovery;
      }
      await this.billingService.releaseBeforeProvider(billing.admission);
      await recoveryOutreachAttemptService.markStatus(attempt.id, "FAILED", {
        failureCode: result.reason,
      });
      return recovery;
    }

    try {
      await this.billingService.commitSuccessfulInitiation({
        admission: billing.admission,
        recoveryId: recovery.id,
        occurredAt: new Date(),
      });
    } catch (error) {
      if (billing.admission.kind === "free" || billing.admission.kind === "lifetime-free") {
        await this.billingService.handleProviderFailure({
          admission: billing.admission,
          error,
        });
      }
      throw error;
    }

    await this.markRecoveryMessageSent(recovery.id);
    const sentAt = new Date();
    const followUpDueAt = policy.followUpEnabled && policy.followUpDelayMinutes
      ? new Date(sentAt.getTime() + policy.followUpDelayMinutes * 60_000)
      : null;
    const persistedMessage = await outboundWhatsAppAdmissionService.findExistingAdmission(`recovery-outreach:${attempt.id}`);
    await recoveryOutreachAttemptService.markWaitingAfterConfirmedSend(attempt.id, {
      sentAt: persistedMessage?.sentAt ?? sentAt,
      outboundMessageId: result.messageId,
    });
    await recoveryOutreachAttemptService.markStatus(attempt.id, "WAITING_FOR_RESPONSE", { followUpDueAt });
    if (followUpDueAt) {
      await recoveryOutreachFollowUpService.schedule(
        { checkoutRecoveryId: recovery.id, sequence: 2 },
        followUpDueAt,
      );
    }

    return recovery;
  }

  async processRecoveryOutreachFollowUp(recoveryId: string) {
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
          await recoveryOutreachAttemptService.markStatus(initial.id, "ENGAGED", { customerRespondedAt: engaged.createdAt });
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
          if (result.kind === "suppressed") {
            if (result.reason === "duplicate") {
              const existing = await outboundWhatsAppAdmissionService.findExistingAdmission(`recovery-outreach:${attempt.id}`);
              if (existing?.status === "SENT" || existing?.status === "DELIVERED" || existing?.status === "READ") {
                await this.billingService.commitSuccessfulInitiation({ admission: billing.admission, recoveryId, occurredAt: existing.sentAt ?? new Date() });
                await recoveryOutreachAttemptService.markWaitingAfterConfirmedSend(attempt.id, { sentAt: existing.sentAt ?? new Date(), outboundMessageId: existing.id });
                return { kind: "sent", attemptId: attempt.id } as const;
              }
              if (existing?.status === "PENDING") return { kind: "suppressed", reason: "send-pending" } as const;
            }
            await this.billingService.releaseBeforeProvider(billing.admission);
            await recoveryOutreachAttemptService.markStatus(attempt.id, "FAILED", { failureCode: result.reason });
            return result;
          }
          await this.billingService.commitSuccessfulInitiation({ admission: billing.admission, recoveryId, occurredAt: new Date() });
          const persistedMessage = await outboundWhatsAppAdmissionService.findExistingAdmission(`recovery-outreach:${attempt.id}`);
          await recoveryOutreachAttemptService.markWaitingAfterConfirmedSend(attempt.id, { sentAt: persistedMessage?.sentAt ?? new Date(), outboundMessageId: result.messageId });
          return { kind: "sent", attemptId: attempt.id } as const;
        } catch (error) {
          await this.billingService.handleProviderFailure({ admission: billing.admission, error });
          await recoveryOutreachAttemptService.markStatus(attempt.id, "FAILED", { failureCode: "PROVIDER_FAILURE" });
          throw error;
        }
      },
    );
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

  async resumeCapacityBlockedRecovery(recoveryId: string) {
    const recovery = await prisma.checkoutRecovery.findUnique({
      where: { id: recoveryId },
      select: {
        id: true,
        shopId: true,
        checkoutToken: true,
        cartToken: true,
        checkoutUrl: true,
        detectedAt: true,
        generation: true,
        status: true,
        admissionBlockReason: true,
        shop: { select: { domain: true, status: true } },
      },
    });
    if (
      !recovery ||
      recovery.status !== "DETECTED" ||
      recovery.admissionBlockReason !== "RECOVERY_CAPACITY_EXHAUSTED"
    ) {
      return { kind: "ignored", reason: "not-capacity-blocked" } as const;
    }
    if (recovery.shop.status !== "ACTIVE") {
      return { kind: "ignored", reason: "shop-unavailable" } as const;
    }
    const execution = await shopExecutionEligibilityService.evaluate(recovery.shopId);
    if (!execution.allowed) {
      return { kind: "ignored", reason: execution.reason } as const;
    }

    return pendingRecoveryCandidateService.withCheckoutLock(
      recovery.shopId,
      recovery.checkoutToken,
      async () => {
        const current = await prisma.checkoutRecovery.findUnique({
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
          },
        });
        if (
          !current ||
          current.status !== "DETECTED" ||
          current.admissionBlockReason !== "RECOVERY_CAPACITY_EXHAUSTED"
        ) {
          return { kind: "ignored", reason: "already-transitioned" } as const;
        }
        const lockedExecution = await shopExecutionEligibilityService.evaluate(
          recovery.shopId,
        );
        if (!lockedExecution.allowed) {
          return { kind: "ignored", reason: lockedExecution.reason } as const;
        }

        const outcome = await abandonedCheckoutLookupService.lookup({
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
        const context = await this.resolveInternationalContext(candidate, outcome.checkout);
        const seed = this.toRecoverySeed(
          candidate,
          recovery.shop.domain,
          outcome.checkout,
          context,
        );
        if ((current.generation ?? 1) === 1) {
          await this.handleCheckoutCreated(seed);
        } else {
          await this.handleCheckoutCreated(seed, current.generation);
        }
        const after = await prisma.checkoutRecovery.findUnique({
          where: { id: recovery.id },
          select: { status: true, admissionBlockReason: true },
        });
        return after?.admissionBlockReason === "RECOVERY_CAPACITY_EXHAUSTED"
          ? { kind: "capacity-exhausted" as const }
          : { kind: "initiated" as const, status: after?.status ?? "DETECTED" };
      },
    );
  }

  private async terminalizeUnrecoverableBlockedRecovery(
    recoveryId: string,
    reason: string,
  ): Promise<void> {
    await prisma.$transaction(async (transaction) => {
      const updated = await transaction.checkoutRecovery.updateMany({
        where: {
          id: recoveryId,
          status: "DETECTED",
          admissionBlockReason: "RECOVERY_CAPACITY_EXHAUSTED",
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

            messages: {
              ...(pendingTurnStartedAt
                ? {
                    where: {
                      createdAt: { gte: pendingTurnStartedAt },
                      direction: "INBOUND",
                      senderType: "CUSTOMER",
                    },
                  }
                : {}),
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              ...(pendingTurnStartedAt ? {} : { take: 20 }),
              select: { id: true, direction: true, content: true },
            },
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

    /*
     * We queried newest-first for efficiency.
     * Reverse them before passing them to the LLM.
     */
    const messages: AgentMessage[] = conversation.messages
      .reverse()
      .map((message) => ({
        role: message.direction === "INBOUND" ? "user" : "assistant",

        content: message.content,
      }));

    return {
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

function lifecycleReason(
  reason: ShopExecutionDenialReason,
) {
  return reason === "CONTRACT_REQUIRED"
    ? "contract-required"
    : reason === "SUBSCRIPTION_FROZEN"
      ? "subscription-frozen"
      : "shop-unavailable";
}

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

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
