import type { RecoveryCheckoutSeed } from "../events/checkout-events.js";
import prisma from "../lib/db.js";

export class ConversationMessageService {
  async createPendingRecoveryMessage(conversationId: string, content: string) {
    return prisma.conversationMessage.create({
      data: {
        conversationId,

        direction: "OUTBOUND",
        senderType: "AUTOMATION",
        status: "PENDING",

        content,
      },
    });
  }

  buildRecoveryMessage(event: RecoveryCheckoutSeed): string {
    const firstItem = event.lineItems[0];

    if (firstItem?.title) {
      return `Hi! It looks like you left ${firstItem.title} in your basket. Would you like some help completing your order?`;
    }

    return "Hi! It looks like you left something in your basket. Would you like some help completing your order?";
  }

  async markMessageSent(messageId: string, providerMessageId: string) {
    return prisma.conversationMessage.update({
      where: {
        id: messageId,
      },

      data: {
        providerMessageId,

        status: "SENT",

        sentAt: new Date(),
      },
    });
  }
}

export const conversationMessageService =
  new ConversationMessageService();