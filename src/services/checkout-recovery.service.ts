// src/services/checkout-recovery.service.ts

import prisma from "../lib/db.js";
import type { CheckoutCreatedEvent } from "../events/checkout-events.js";
import { customerService } from "./customer.service.js";
import { conversationService } from "./conversation.service.js";
import { conversationMessageService } from "./conversation.message.service.js";
import { whatsAppService } from "./whatsapp.service.js";
import type { AgentMessage, RecoveryAgentContext } from "../agents/types.js";

export interface OrderCompletedEvent {
  shop: string;
  orderId: string;
  checkoutToken: string | null;
  customerId: string | null;
  totalPrice: string | null;
  currency: string | null;
}

export class CheckoutRecoveryService {
  async upsertRecovery(event: CheckoutCreatedEvent) {
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

  resolveRecipient(event: CheckoutCreatedEvent): string {
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

  async handleOrderCompleted(event: OrderCompletedEvent) {
    if (!event.checkoutToken) {
      return { kind: "ignored", reason: "missing-checkout-token" } as const;
    }

    const checkoutToken = event.checkoutToken;

    const shop = await prisma.shop.findUnique({
      where: { domain: event.shop },
      select: { id: true },
    });

    if (!shop) {
      return { kind: "ignored", reason: "shop-not-found" } as const;
    }

    return prisma.$transaction(async (transaction) => {
      const recovery = await transaction.checkoutRecovery.findUnique({
        where: {
          shopId_checkoutToken: {
            shopId: shop.id,
              checkoutToken,
          },
        },
        select: { id: true, status: true, completedAt: true },
      });

      if (!recovery) {
        return { kind: "ignored", reason: "recovery-not-found" } as const;
      }

      if (["COMPLETED", "EXPIRED", "CANCELLED"].includes(recovery.status)) {
        return { kind: "ignored", reason: `terminal-${recovery.status.toLowerCase()}` } as const;
      }

      const completedAt = new Date();
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
  }

  async handleCheckoutCreated(event: CheckoutCreatedEvent) {
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