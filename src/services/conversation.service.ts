import prisma from "../lib/db.js";

import type {
  AgentMessage,
  AgentConversationContext,
} from "../agents/types.js";

import type {
  MessageDirection,
} from "../domain/types.js";

export interface ResolvedIncomingMessage {
  conversationId: string;

  providerMessageId: string;

  /**
   * Meta context.id if the customer explicitly
   * replied to one of our messages.
   */
  inReplyToProviderId: string | null;

  content: string;
}

export class ConversationService {

  /**
   * Persist an inbound customer message.
   *
   * At this point the WhatsApp layer has already resolved
   * which Conversation this message belongs to.
   */
  async receiveMessage(
    message: ResolvedIncomingMessage,
  ): Promise<{
    conversationId: string;
    version: number;
    duplicate: boolean;
  }> {

    /*
     * First protect against Meta delivering the
     * same message more than once.
     */
    const existing =
      await prisma.conversationMessage.findUnique({
        where: {
          providerMessageId:
            message.providerMessageId,
        },

        include: {
          conversation: {
            select: {
              inboundVersion: true,
            },
          },
        },
      });

    if (existing) {
      return {
        conversationId:
          existing.conversationId,

        version:
          existing.conversation.inboundVersion,

        duplicate: true,
      };
    }

    /*
     * Persist the message and increment the
     * conversation version together.
     */
    const result = await prisma.$transaction(
      async (tx) => {

        await tx.conversationMessage.create({
          data: {
            conversationId:
              message.conversationId,

            providerMessageId:
              message.providerMessageId,

            inReplyToProviderId:
              message.inReplyToProviderId,

            direction: "INBOUND",

            senderType: "CUSTOMER",

            status: "DELIVERED",

            content: message.content,
          },
        });

        const conversation =
          await tx.conversation.update({
            where: {
              id: message.conversationId,
            },

            data: {
              inboundVersion: {
                increment: 1,
              },

              lastInboundAt: new Date(),
              lastMessageAt: new Date(),
            },

            select: {
              id: true,
              inboundVersion: true,
            },
          });

        return conversation;
      },
    );

    return {
      conversationId: result.id,
      version: result.inboundVersion,
      duplicate: false,
    };
  }


  /**
   * Return the bounded conversation history needed
   * by the commerce agent.
   */
  async getAgentSnapshot(
    conversationId: string,
  ): Promise<AgentConversationContext> {

    const conversation =
      await prisma.conversation.findUniqueOrThrow({
        where: {
          id: conversationId,
        },

        select: {
          id: true,
          type: true,
          summary: true,
          inboundVersion: true,

          checkoutRecovery: {
            select: {
              shop: {
                select: {
                  domain: true,
                },
              },
            },
          },
        },
      });

    const messages =
      await prisma.conversationMessage.findMany({
        where: {
          conversationId,
        },

        orderBy: {
          createdAt: "desc",
        },

        take: 20,

        select: {
          direction: true,
          content: true,
        },
      });

    const normalizedMessages: AgentMessage[] =
      messages
        .reverse()
        .map((message) =>
          this.toAgentMessage(message),
        );

    return {
      conversationId: conversation.id,

      shop:
        conversation.checkoutRecovery.shop.domain,

      type: conversation.type,

      version:
        conversation.inboundVersion,

      summary:
        conversation.summary,

      messages:
        normalizedMessages,
    };
  }


  /**
   * Used after an LLM call to determine whether a
   * newer customer message arrived while the agent
   * was processing.
   */
  async hasChanged(
    conversationId: string,
    version: number,
  ): Promise<boolean> {

    const conversation =
      await prisma.conversation.findUniqueOrThrow({
        where: {
          id: conversationId,
        },

        select: {
          inboundVersion: true,
        },
      });

    return (
      conversation.inboundVersion !== version
    );
  }


  /**
   * Every CheckoutRecovery can have one RECOVERY
   * conversation.
   *
   * This requires:
   *
   * @@unique([checkoutRecoveryId, type])
   */
  async getOrCreateRecoveryConversation(
    checkoutRecoveryId: string,
  ) {

    return prisma.conversation.upsert({
      where: {
        checkoutRecoveryId_type: {
          checkoutRecoveryId,
          type: "RECOVERY",
        },
      },

      create: {
        checkoutRecoveryId,
        type: "RECOVERY",
      },

      update: {},
    });
  }


  /**
   * Persist an outbound agent response BEFORE
   * sending it to WhatsApp.
   */
  async createPendingAgentMessage(
    conversationId: string,
    content: string,
  ) {

    return prisma.conversationMessage.create({
      data: {
        conversationId,

        direction: "OUTBOUND",

        senderType: "AGENT",

        status: "PENDING",

        content,
      },
    });
  }


  /**
   * Once Meta accepts the outbound message,
   * attach the wamid to our persisted message.
   */
  async markMessageSent(
    messageId: string,
    providerMessageId: string,
  ) {

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


  /**
   * Mark which inbound version the agent has
   * successfully dealt with.
   */
  async markProcessed(
    conversationId: string,
    version: number,
  ) {

    return prisma.conversation.update({
      where: {
        id: conversationId,
      },

      data: {
        lastProcessedVersion: version,
      },
    });
  }


  /**
   * Convert our domain representation into the
   * format expected by the agent.
   *
   * We deliberately don't persist "user" /
   * "assistant" in the database.
   */
  private toAgentMessage(
    message: {
      direction: MessageDirection;
      content: string;
    },
  ): AgentMessage {

    return {
      role:
        message.direction === "INBOUND"
          ? "user"
          : "assistant",

      content: message.content,
    };
  }
}

export const conversationService =
  new ConversationService();