// src/services/recovery-routing.service.ts

import type { WhatsAppInboundEvent } from "../integration/whatsapp/types.js";
import prisma from "../lib/db.js";

export type RecoveryRoute =
  | {
      kind: "resolved";
      conversationId: string;
      checkoutRecoveryId: string;
    }
  | {
      kind: "product-only";
      customerPhone: string;
      shop?: string;
      customerId?: string;
    }
  | {
      kind: "clarify";
      customerPhone: string;
      recoveries: Array<{
        id: string;
        checkoutToken: string;
        status: string;
        totalPrice: string | null;
      }>;
    };

export class RecoveryRoutingService {
  async resolveInboundMessage(
    event: WhatsAppInboundEvent,
  ): Promise<RecoveryRoute> {
    if (event.contextMessageId) {
      const originalMessage =
        await prisma.conversationMessage.findUnique({
          where: {
            providerMessageId:
              event.contextMessageId,
          },

          select: {
            conversationId: true,

            conversation: {
              select: {
                checkoutRecoveryId: true,
              },
            },
          },
        });

      if (originalMessage) {
        return {
          kind: "resolved",
          conversationId:
            originalMessage.conversationId,
          checkoutRecoveryId:
            originalMessage.conversation.checkoutRecoveryId,
        };
      }
    }

    return this.resolveWithoutContext(
      event.customerPhone,
    );
  }

  private async resolveWithoutContext(
    customerPhone: string,
  ): Promise<RecoveryRoute> {
    const conversations =
      await prisma.conversation.findMany({
        where: {
          checkoutRecovery: {
            customer: {
              phone: customerPhone,
            },

            status: {
              in: [
                "MESSAGE_SENT",
                "ENGAGED",
                "COMPLETED",
              ],
            },
          },
        },

        orderBy: {
          lastMessageAt: "desc",
        },

        take: 10,

        select: {
          id: true,
          checkoutRecoveryId: true,
          checkoutRecovery: {
            select: {
              id: true,
              status: true,
              checkoutToken: true,
              totalPrice: true,
              customer: {
                select: {
                  id: true,
                  phone: true,
                },
              },
            },
          },
        },
      });

    if (conversations.length === 0) {
      return this.resolveProductOnlyCustomer(
        customerPhone,
      );
    }

    if (conversations.length === 1) {
      const conversation = conversations[0];

      if (!conversation) {
        throw new Error(
          "Expected a recovery conversation",
        );
      }

      return {
        kind: "resolved",
        conversationId: conversation.id,
        checkoutRecoveryId:
          conversation.checkoutRecoveryId,
      };
    }

    return {
      kind: "clarify",
      customerPhone,
      recoveries: conversations.map(
        (conversation) => ({
          id: conversation.checkoutRecovery.id,
          checkoutToken:
            conversation.checkoutRecovery.checkoutToken,
          status: conversation.checkoutRecovery.status,
          totalPrice:
            conversation.checkoutRecovery.totalPrice?.toString() ?? null,
        }),
      ),
    };
  }

  private async resolveProductOnlyCustomer(
    customerPhone: string,
  ): Promise<RecoveryRoute> {
    const normalizedPhone = customerPhone.trim();

    const activeCustomerPhones =
      await prisma.customerPhone.findMany({
        where: {
          phone: normalizedPhone,
          endedAt: null,
        },
        select: {
          customerId: true,
          customer: {
            select: {
              shopId: true,
              shop: {
                select: {
                  domain: true,
                },
              },
            },
          },
        },
        take: 10,
      });

    const matchingCustomer =
      activeCustomerPhones[0]?.customer;

    if (!matchingCustomer) {
      return {
        kind: "product-only",
        customerPhone,
      };
    }

    return {
      kind: "product-only",
      customerPhone,
      shop: matchingCustomer.shop.domain,
      customerId: activeCustomerPhones[0].customerId,
    };
  }
}

export const recoveryRoutingService =
  new RecoveryRoutingService();
