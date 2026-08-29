// src/services/checkout-recovery.service.ts

import prisma from "../lib/db.js";
import type { RecoveryCheckoutSeed } from "../events/checkout-events.js";
import type {
  CheckoutCreatedContractInput,
  CheckoutUpdatedContractInput,
  OrderCompletedContractInput,
} from "../events/shopify-contract-adapter.js";
import { customerService } from "./customer.service.js";
import { conversationService } from "./conversation.service.js";
import { conversationMessageService } from "./conversation.message.service.js";
import { whatsAppService } from "./whatsapp.service.js";
import { pendingRecoveryCandidateService } from "./pending-recovery-candidate.service.js";
import {
  abandonedCheckoutLookupService,
} from "./abandoned-checkout-lookup.service.js";
import {
  toLookupInput,
  type AbandonedCheckoutLookupInput,
  type NormalizedAbandonedCheckout,
} from "../domain/abandoned-checkout.js";
import type { PendingRecoveryCandidate } from "../domain/pending-recovery-candidate.js";
import type { AgentMessage, RecoveryAgentContext } from "../agents/types.js";

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
  | { outcome: "discarded-order-completed"; checkoutToken: string };

export type CheckoutRefreshResult =
  | { kind: "refreshed"; recoveryId: string; status: string }
  | { kind: "discarded"; reason: string }
  | { kind: "ignored"; reason: string };

export class CheckoutRecoveryService {
  async handleCheckoutCreatedContract(event: CheckoutCreatedContractInput) {
    const scheduled =
      await pendingRecoveryCandidateService.scheduleFromCheckoutCreated(event);

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
    const shopDomain =
      await abandonedCheckoutLookupService.resolveShopDomain(candidate.shopId);

    // Checkout-scoped serialization with the order path (ARCH-001-BACKGROUND-005).
    return pendingRecoveryCandidateService.withCheckoutLock(
      candidate.shopId,
      candidate.checkoutToken,
      async () => {
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

        const outcome =
          await abandonedCheckoutLookupService.lookup(
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
          return { outcome: "discarded-not-found", checkoutToken: candidate.checkoutToken } as const;
        }

        if (outcome.kind === "ambiguous") {
          return { outcome: "discarded-ambiguous", checkoutToken: candidate.checkoutToken } as const;
        }

        if (outcome.kind === "bounded-limit-exceeded") {
          return { outcome: "discarded-bound-exceeded", checkoutToken: candidate.checkoutToken } as const;
        }

    const checkout = outcome.checkout;

        // Shopify reports the checkout already completed: not recoverable.
        if (checkout.completedAt != null) {
          return { outcome: "discarded-not-recoverable", checkoutToken: candidate.checkoutToken } as const;
        }

        // Idempotency guard: never reopen an existing recovery or re-run the
        // recovery-message workflow for a checkout that has already materialized.
        const existing = await this.findExistingRecovery(shopDomain, candidate.checkoutToken);
        if (existing) {
          if (["COMPLETED", "EXPIRED", "CANCELLED"].includes(existing.status)) {
            return { outcome: "discarded-terminal", checkoutToken: candidate.checkoutToken, status: existing.status } as const;
          }
          return { outcome: "no-op-existing", checkoutToken: candidate.checkoutToken, status: existing.status } as const;
        }

        const seed = this.toRecoverySeed(candidate, shopDomain, checkout);
        await this.handleCheckoutCreated(seed);

    return { outcome: "recovery-created", checkoutToken: seed.checkoutToken } as const;
      },
    );
  }

  private async findExistingRecovery(shopDomain: string, checkoutToken: string) {
    const shop = await prisma.shop.findUnique({
      where: { domain: shopDomain },
      select: { id: true },
    });
    if (!shop) {
      return null;
    }
    return prisma.checkoutRecovery.findUnique({
      where: {
        shopId_checkoutToken: {
          shopId: shop.id,
          checkoutToken,
        },
      },
      select: { status: true },
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
  ): RecoveryCheckoutSeed {
    return {
      shop: shopDomain,
      checkoutToken: candidate.checkoutToken,
      cartToken: candidate.cartToken,
      detectedAt: checkout.createdAt || candidate.checkoutCreatedAt || new Date().toISOString(),
      currency: checkout.currencyCode,
      totalPrice: checkout.totalPrice,
      checkoutUrl: checkout.abandonedCheckoutUrl,
      completedAt: checkout.completedAt,
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
      select: { id: true },
    });
    if (!shop) {
      return { kind: "discarded", reason: "shop-not-found" } as const;
    }

    const recovery = await prisma.checkoutRecovery.findUnique({
      where: {
        shopId_checkoutToken: {
          shopId: shop.id,
          checkoutToken: event.checkoutToken,
        },
      },
      select: {
        id: true,
        status: true,
        cartToken: true,
        checkoutUrl: true,
        detectedAt: true,
      },
    });

    // No recovery: the update is irrelevant before recovery exists.
    if (!recovery) {
      return { kind: "discarded", reason: "recovery-not-found" } as const;
    }

    // A terminal recovery is never reopened by a checkout update.
    if (["COMPLETED", "EXPIRED", "CANCELLED"].includes(recovery.status)) {
      return {
        kind: "ignored",
        reason: `terminal-${recovery.status.toLowerCase()}`,
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
    const refreshed = await prisma.checkoutRecovery.updateMany({
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

    if (refreshed.count === 0) {
      return { kind: "ignored", reason: "already-transitioned" } as const;
    }

    return {
      kind: "refreshed",
      recoveryId: recovery.id,
      status: recovery.status,
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

  async upsertRecovery(event: RecoveryCheckoutSeed) {
    const shop = await prisma.shop.findUniqueOrThrow({
      where: {
        domain: event.shop,
      },
      select: {
        id: true,
      },
    });

    return prisma.checkoutRecovery.upsert({
      where: {
        shopId_checkoutToken: {
          shopId: shop.id,
          checkoutToken: event.checkoutToken,
        },
      },

      create: {
        shopId: shop.id,

        checkoutToken: event.checkoutToken,
        cartToken: event.cartToken,

        status: "DETECTED",

        currency: event.currency,

        totalPrice: event.totalPrice !== null ? event.totalPrice : null,

        checkoutUrl: event.checkoutUrl,

        lineItems: event.lineItems,

        detectedAt: new Date(event.detectedAt),

        completedAt:
          event.completedAt !== null ? new Date(event.completedAt) : null,
      },

      update: {
        cartToken: event.cartToken,
        currency: event.currency,

        totalPrice: event.totalPrice !== null ? event.totalPrice : null,

        checkoutUrl: event.checkoutUrl,

        lineItems: event.lineItems,

        completedAt:
          event.completedAt !== null ? new Date(event.completedAt) : null,
      },
    });
  }

  async attachCustomer(recoveryId: string, customerId: string) {
    return prisma.checkoutRecovery.update({
      where: {
        id: recoveryId,
      },

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
    return prisma.checkoutRecovery.update({
      where: {
        id: recoveryId,
      },

      data: {
        status: "MESSAGE_SENT",
        messageSentAt: new Date(),
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
      select: { id: true },
    });

    if (!shop) {
      return { kind: "ignored", reason: "shop-not-found" } as const;
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
          const recovery = await transaction.checkoutRecovery.findUnique({
            where: {
              shopId_checkoutToken: {
                shopId: shop.id,
                checkoutToken,
              },
            },
            select: { id: true, status: true },
          });

          if (!recovery) {
            return { kind: "discarded", reason: "recovery-not-found" } as const;
          }

          if (
            ["COMPLETED", "EXPIRED", "CANCELLED"].includes(recovery.status)
          ) {
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

  async handleCheckoutCreated(event: RecoveryCheckoutSeed) {
    // 1
    let recovery = await this.upsertRecovery(event);

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

    // 3
    const recipient = this.resolveRecipient(event);

    // 4
    const conversation =
      await conversationService.getOrCreateRecoveryConversation(recovery.id);

    const content = conversationMessageService.buildRecoveryMessage(event);

    // 5a - persist intent to send
    const message =
      await conversationMessageService.createPendingRecoveryMessage(
        conversation.id,
        content,
      );

    try {
      // 5b
      const result = await whatsAppService.sendWhatsAppText({
        to: recipient,
        text: content,
      });

      // 6
      await conversationMessageService.markMessageSent(
        message.id,
        result.providerMessageId,
      );

      await this.markRecoveryMessageSent(recovery.id);

      return recovery;
    } catch (error) {
      await prisma.conversationMessage.update({
        where: {
          id: message.id,
        },

        data: {
          status: "FAILED",
        },
      });

      throw error;
    }
  }

  async getAgentContext({
    checkoutRecoveryId,
    conversationId,
  }: {
    checkoutRecoveryId: string;
    conversationId: string;
  }): Promise<RecoveryAgentContext> {
    const recovery =
      await prisma.checkoutRecovery.findUnique({
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

              messages: {
                orderBy: {
                  createdAt: "desc",
                },

                take: 20,

                select: {
                  direction: true,
                  content: true,
                },
              },
            },
          },
        },
      });

    if (!recovery) {
      throw new Error(
        `Checkout recovery not found: ${checkoutRecoveryId}`,
      );
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
    const messages: AgentMessage[] =
      conversation.messages
        .reverse()
        .map((message) => ({
          role:
            message.direction === "INBOUND"
              ? "user"
              : "assistant",

          content: message.content,
        }));

    return {
      shop: recovery.shop.domain,

      recovery: {
        id: recovery.id,

        status: recovery.status,

        checkoutToken:
          recovery.checkoutToken,

        completedAt:
          recovery.completedAt,

        totalPrice:
          recovery.totalPrice?.toString() ??
          null,
      },

      customer: recovery.customer
        ? {
            id: recovery.customer.id,

            phone:
              recovery.customer.phone,

            firstName:
              recovery.customer.firstName,
          }
        : null,

      conversation: {
        conversationId: conversation.id,

        shop: recovery.shop.domain,

        type: conversation.type,

        summary:
          conversation.summary,

        version:
          conversation.inboundVersion,

        messages,
      },
    };
  }
}

export const checkoutRecoveryService =
  new CheckoutRecoveryService();


