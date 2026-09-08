import prisma from "../lib/db.js";

import type {
  AgentMessage,
  AgentConversationContext,
} from "../agents/types.js";

import type {
  MessageDirection,
} from "../domain/types.js";
import type { InternationalContext } from "@modainteract/moda-interact-shared/internationalization";
import {
  ConversationLanguageService,
  conversationLanguageService,
} from "./conversation-language.service.js";

export interface ResolvedIncomingMessage {
  conversationId: string;

  providerMessageId: string;

  /**
   * Meta context.id if the customer explicitly
   * replied to one of our messages.
   */
  inReplyToProviderId: string | null;

  content: string;

  explicitLanguageTag?: string | null;
}

export class ConversationService {
  constructor(
    private readonly languageService: ConversationLanguageService = conversationLanguageService,
  ) {}

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
              languageTag: true,
              languageSource: true,
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

    const currentConversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: message.conversationId },
      select: {
        languageTag: true,
        languageSource: true,
      },
    });

    const language = await this.languageService.resolveInitial({
      currentLanguageTag: currentConversation.languageTag,
      currentLanguageSource: fromPrismaLanguageSource(
        currentConversation.languageSource,
      ),
      ...(message.explicitLanguageTag !== undefined
        ? { explicitLanguageTag: message.explicitLanguageTag }
        : {}),
      shopifyLanguageTag: null,
      merchantLanguageTag: null,
      platformLanguageTag: null,
    });

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
              languageTag: language.languageTag,
              languageSource: toPrismaLanguageSource(language.languageSource),
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
          languageTag: true,
          languageSource: true,

          shop: {
            select: {
              domain: true,
            },
          },

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
    const shop = conversation.checkoutRecovery?.shop.domain ?? conversation.shop?.domain;
    if (!shop) {
      throw new Error(`Conversation ${conversation.id} has no shop ownership`);
    }

    return {
      conversationId: conversation.id,

      shop:
        shop,

      type: conversation.type,

      version:
        conversation.inboundVersion,

      languageTag: conversation.languageTag,

      languageSource: fromPrismaLanguageSource(conversation.languageSource),

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

  async applyDetectedLanguage({
    conversationId,
    version,
    message,
    detectedLanguageTag,
    detectedLanguageConfidence,
  }: {
    conversationId: string;
    version: number;
    message: string;
    detectedLanguageTag: string | null;
    detectedLanguageConfidence: number | null;
  }): Promise<boolean> {
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { inboundVersion: true, languageTag: true, languageSource: true },
    });

    if (conversation.inboundVersion !== version) {
      return false;
    }

    const language = this.languageService.acceptDetectedLanguage({
      message,
      currentLanguageTag: conversation.languageTag,
      currentLanguageSource: fromPrismaLanguageSource(conversation.languageSource),
      detectedLanguageTag,
      detectedLanguageConfidence,
    });

    if (!language.changed) {
      return false;
    }

    const updated = await prisma.conversation.updateMany({
      where: { id: conversationId, inboundVersion: version },
      data: {
        languageTag: language.languageTag,
        languageSource: toPrismaLanguageSource(language.languageSource),
      },
    });

    return updated.count === 1;
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
    internationalContext?: InternationalContext,
  ) {

    return prisma.conversation.upsert({
      where: { checkoutRecoveryId },

      create: {
        checkoutRecoveryId,
        type: "RECOVERY",
        ...(internationalContext
          ? {
              languageTag: internationalContext.languageTag,
              languageSource: toPrismaLanguageSource(internationalContext.languageSource),
              countryCode: internationalContext.countryCode,
              currencyCode: internationalContext.currencyCode,
              timeZone: internationalContext.timeZone,
            }
          : {}),
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

function toPrismaLanguageSource(source: InternationalContext["languageSource"]):
  "CUSTOMER_EXPLICIT" | "DETECTED" | "SHOPIFY" | "MERCHANT_DEFAULT" | "PLATFORM_DEFAULT" | null {
  if (!source) return null;
  return source.replaceAll("-", "_").toUpperCase() as ReturnType<typeof toPrismaLanguageSource>;
}

function fromPrismaLanguageSource(
  source: "CUSTOMER_EXPLICIT" | "DETECTED" | "SHOPIFY" | "MERCHANT_DEFAULT" | "PLATFORM_DEFAULT" | null | undefined,
): InternationalContext["languageSource"] {
  if (!source) return null;
  return source.toLowerCase().replaceAll("_", "-") as NonNullable<InternationalContext["languageSource"]>;
}

export const conversationService =
  new ConversationService();