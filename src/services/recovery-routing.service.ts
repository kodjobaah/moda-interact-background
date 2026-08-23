// src/services/recovery-routing.service.ts

import type { WhatsAppInboundEvent } from "../integration/whatsapp/types.js";
import prisma from "../lib/db.js";


export class RecoveryRoutingService {
  async resolveInboundMessage(
    event: WhatsAppInboundEvent,
  ): Promise<{
    checkoutRecoveryId: string;
    conversationId: string;
  }> {
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
  ): Promise<{
    checkoutRecoveryId: string;
    conversationId: string;
  }> {
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

        take: 2,

        select: {
          id: true,
          checkoutRecoveryId: true,
        },
      });

    if (conversations.length === 0) {
      throw new Error(
        `No recovery conversation found for ${customerPhone}`,
      );
    }

    if (conversations.length > 1) {
      throw new Error(
        `Ambiguous recovery conversation for ${customerPhone}`,
      );
    }

    const conversation = conversations[0];

    if (!conversation) {
      throw new Error(
        "Expected a recovery conversation",
      );
    }

    return {
      conversationId: conversation.id,
      checkoutRecoveryId:
        conversation.checkoutRecoveryId,
    };
  }
}

export const recoveryRoutingService =
  new RecoveryRoutingService();