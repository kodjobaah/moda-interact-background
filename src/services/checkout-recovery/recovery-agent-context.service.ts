import type { PrismaClient } from "@prisma/client";
import type { RecoveryAgentContext } from "../../agents/types.js";
import type { conversationService } from "../conversation.service.js";
import { loadCommerceHistory } from "../../commerce/history.js";

export interface RecoveryAgentContextInput {
  checkoutRecoveryId: string;
  conversationId: string;
  pendingTurnStartedAt?: Date | null;
}

type RecoveryContextDatabase = Pick<PrismaClient, "checkoutRecovery">;
type ConversationSnapshotPort = Pick<typeof conversationService, "getAgentSnapshot">;
type CommerceHistoryLoader = typeof loadCommerceHistory;

export class RecoveryAgentContextService {
  constructor(
    private readonly database: RecoveryContextDatabase,
    private readonly conversationService: ConversationSnapshotPort,
    private readonly loadCommerceHistory: CommerceHistoryLoader,
  ) {}

  async getAgentContext({
    checkoutRecoveryId,
    conversationId,
    pendingTurnStartedAt,
  }: RecoveryAgentContextInput): Promise<RecoveryAgentContext> {
    const recovery = await this.database.checkoutRecovery.findUnique({
      where: { id: checkoutRecoveryId },
      select: {
        id: true,
        shopId: true,
        shop: { select: { domain: true } },
        status: true,
        checkoutToken: true,
        completedAt: true,
        totalPrice: true,
        customer: { select: { id: true, phone: true, firstName: true } },
        conversation: {
          where: { id: conversationId },
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

    const bounded = await this.loadCommerceHistory(
      conversationId,
      pendingTurnStartedAt ?? new Date(),
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
        messages: bounded.currentMessages,
        history: bounded.history,
        oversized: bounded.oversized,
      },
    };
  }

  async getAgentContextForStandaloneConversation({
    checkoutRecoveryId,
    conversationId,
    pendingTurnStartedAt,
  }: RecoveryAgentContextInput): Promise<RecoveryAgentContext> {
    const recovery = await this.database.checkoutRecovery.findUnique({
      where: { id: checkoutRecoveryId },
      select: {
        id: true,
        shopId: true,
        shop: { select: { domain: true } },
        status: true,
        checkoutToken: true,
        completedAt: true,
        totalPrice: true,
        customer: { select: { id: true, phone: true, firstName: true } },
      },
    });

    if (!recovery) {
      throw new Error(`Checkout recovery not found: ${checkoutRecoveryId}`);
    }

    const conversation = await this.conversationService.getAgentSnapshot(
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