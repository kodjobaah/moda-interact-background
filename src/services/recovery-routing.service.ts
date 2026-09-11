// src/services/recovery-routing.service.ts

import type { WhatsAppInboundEvent } from "../integration/whatsapp/types.js";
import prisma from "../lib/db.js";
import { Prisma } from "@prisma/client";
import { shopExecutionEligibilityService } from "./shop-execution-eligibility.service.js";

const STANDALONE_CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;
type StandaloneConversationType = "PRODUCT_DISCOVERY" | "PRODUCT_SUPPORT";

export type RecoveryRoute =
  | {
      kind: "resolved";
      conversationId: string;
      checkoutRecoveryId: string;
      shopId: string;
    }
  | {
      kind: "product-only";
      customerPhone: string;
      shop?: string;
      shopId?: string;
      customerId?: string;
      conversationId?: string;
      type: "PRODUCT_DISCOVERY";
    }
  | {
      kind: "standalone";
      conversationId: string;
      customerPhone: string;
      shop: string;
      shopId: string;
      customerId: string;
      type: StandaloneConversationType;
    }
  | {
      kind: "clarify";
      conversationId: string;
      customerPhone: string;
      shopId: string;
      customerId: string;
      recoveries: Array<{
        id: string;
        checkoutToken: string;
        status: string;
        totalPrice: string | null;
      }>;
    }
  | {
      kind: "unresolved";
      reason: "ambiguous-tenant";
      customerPhone: string;
    }
  | {
      kind: "shop-unavailable";
      customerPhone: string;
    };

export type CurrentTurnRouting =
  | {
      kind: "standalone";
      shopId: string;
      customerPhone: string;
    }
  | {
      kind: "resolved";
      shopId: string;
      customerPhone: string;
      checkoutRecoveryId: string;
    }
  | {
      kind: "clarify";
      shopId: string;
      customerPhone: string;
      recoveries: Array<{
        checkoutToken: string;
        totalPrice: string | null;
      }>;
    }
  | {
      kind: "unresolved";
      reason: "ambiguous-tenant" | "overflow";
      customerPhone: string;
    };

export class RecoveryRoutingService {
  async getCurrentClarification(
    conversationId: string,
  ): Promise<CurrentTurnRouting | null> {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        type: true,
        shopId: true,
        customerId: true,
        customer: { select: { phone: true } },
      },
    });

    if (
      conversation?.type !== "PRODUCT_SUPPORT" ||
      !conversation.shopId ||
      !conversation.customerId ||
      !conversation.customer?.phone
    ) {
      return null;
    }

    const conversations = await prisma.conversation.findMany({
      where: {
        checkoutRecovery: {
          customer: { phone: conversation.customer.phone },
          status: { in: ["MESSAGE_SENT", "ENGAGED", "COMPLETED"] },
        },
      },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: 11,
      select: {
        checkoutRecovery: {
          select: {
            id: true,
            shopId: true,
            customer: { select: { id: true, phone: true } },
            checkoutToken: true,
            totalPrice: true,
          },
        },
      },
    });

    if (conversations.length === 11) {
      return {
        kind: "unresolved",
        reason: "overflow",
        customerPhone: conversation.customer.phone,
      };
    }

    if (conversations.length === 0) {
      return {
        kind: "standalone",
        shopId: conversation.shopId,
        customerPhone: conversation.customer.phone,
      };
    }

    const ownershipPairs = new Map<
      string,
      { shopId: string; customerId: string }
    >();
    for (const candidate of conversations) {
      const recovery = candidate.checkoutRecovery;
      const customerId = recovery?.customer?.id;
      if (!recovery?.shopId || !customerId) {
        return {
          kind: "unresolved",
          reason: "ambiguous-tenant",
          customerPhone: conversation.customer.phone,
        };
      }
      ownershipPairs.set(`${recovery.shopId}:${customerId}`, {
        shopId: recovery.shopId,
        customerId,
      });
    }

    if (ownershipPairs.size !== 1) {
      return {
        kind: "unresolved",
        reason: "ambiguous-tenant",
        customerPhone: conversation.customer.phone,
      };
    }

    const ownership = [...ownershipPairs.values()][0];
    if (!ownership) {
      return {
        kind: "unresolved",
        reason: "ambiguous-tenant",
        customerPhone: conversation.customer.phone,
      };
    }

    if (
      ownership.shopId !== conversation.shopId ||
      ownership.customerId !== conversation.customerId
    ) {
      return {
        kind: "unresolved",
        reason: "ambiguous-tenant",
        customerPhone: conversation.customer.phone,
      };
    }

    if (conversations.length === 1) {
      const recovery = conversations[0]?.checkoutRecovery;
      if (!recovery) {
        return {
          kind: "unresolved",
          reason: "ambiguous-tenant",
          customerPhone: conversation.customer.phone,
        };
      }
      return {
        kind: "resolved",
        shopId: ownership.shopId,
        customerPhone: conversation.customer.phone,
        checkoutRecoveryId: recovery.id,
      };
    }

    return {
      kind: "clarify",
      shopId: ownership.shopId,
      customerPhone: conversation.customer.phone,
      recoveries: conversations.flatMap((candidate) =>
        candidate.checkoutRecovery
          ? [
              {
                checkoutToken: candidate.checkoutRecovery.checkoutToken,
                totalPrice:
                  candidate.checkoutRecovery.totalPrice?.toString() ?? null,
              },
            ]
          : [],
      ),
    };
  }

  async resolveInboundMessage(
    event: WhatsAppInboundEvent,
  ): Promise<RecoveryRoute> {
    if (event.contextMessageId) {
      const originalMessage = await prisma.conversationMessage.findUnique({
        where: {
          providerMessageId: event.contextMessageId,
        },

        select: {
          conversationId: true,

          conversation: {
            select: {
              checkoutRecoveryId: true,
              shopId: true,
              customerId: true,
              type: true,
              shop: { select: { domain: true } },
              checkoutRecovery: { select: { shopId: true } },
            },
          },
        },
      });

      if (originalMessage) {
        const shopId =
          originalMessage.conversation.checkoutRecovery?.shopId ??
          originalMessage.conversation.shopId;
        if (
          shopId &&
          !(await shopExecutionEligibilityService.isShopExecutionActive(shopId))
        ) {
          return { kind: "shop-unavailable", customerPhone: event.customerPhone };
        }

        if (!originalMessage.conversation.checkoutRecoveryId) {
          if (
            originalMessage.conversation.shopId &&
            originalMessage.conversation.customerId &&
            originalMessage.conversation.shop
          ) {
            return {
              kind: "standalone",
              conversationId: originalMessage.conversationId,
              customerPhone: event.customerPhone,
              shop: originalMessage.conversation.shop.domain,
              shopId: originalMessage.conversation.shopId,
              customerId: originalMessage.conversation.customerId,
              type: originalMessage.conversation
                .type as StandaloneConversationType,
            };
          }
          throw new Error(
            "Original message has no durable conversation ownership",
          );
        }

        return {
          kind: "resolved",
          conversationId: originalMessage.conversationId,
          checkoutRecoveryId: originalMessage.conversation.checkoutRecoveryId,
          shopId: originalMessage.conversation.checkoutRecovery?.shopId ?? "",
        };
      }
    }

    return this.resolveWithoutContext(event.customerPhone);
  }

  private async resolveWithoutContext(
    customerPhone: string,
  ): Promise<RecoveryRoute> {
    const conversations = await prisma.conversation.findMany({
      where: {
        checkoutRecovery: {
          customer: {
            phone: customerPhone,
          },

          status: {
            in: ["MESSAGE_SENT", "ENGAGED", "COMPLETED"],
          },
        },
      },

      orderBy: {
        lastMessageAt: "desc",
      },

      take: 11,

      select: {
        id: true,
        checkoutRecoveryId: true,
        checkoutRecovery: {
          select: {
            shopId: true,
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
      return this.resolveProductOnlyCustomer(customerPhone);
    }

    if (conversations.length === 11) {
      return { kind: "unresolved", reason: "ambiguous-tenant", customerPhone };
    }

    if (conversations.length === 1) {
      const conversation = conversations[0];

      if (!conversation) {
        throw new Error("Expected a recovery conversation");
      }

      if (!conversation.checkoutRecoveryId) {
        throw new Error("Recovery conversation is missing its recovery ID");
      }

      if (!conversation.checkoutRecovery) {
        throw new Error(
          "Recovery conversation is missing its checkout recovery",
        );
      }

      if (
        !(await shopExecutionEligibilityService.isShopExecutionActive(
          conversation.checkoutRecovery.shopId,
        ))
      ) {
        return { kind: "shop-unavailable", customerPhone };
      }

      return {
        kind: "resolved",
        conversationId: conversation.id,
        checkoutRecoveryId: conversation.checkoutRecoveryId,
        shopId: conversation.checkoutRecovery.shopId,
      };
    }

    const candidateShopIds = [
      ...new Set(
        conversations.flatMap((conversation) =>
          conversation.checkoutRecovery?.shopId
            ? [conversation.checkoutRecovery.shopId]
            : [],
        ),
      ),
    ];
    const activeShopIds = new Set(
      (
        await Promise.all(
          candidateShopIds.map(async (shopId) =>
            (await shopExecutionEligibilityService.isShopExecutionActive(shopId))
              ? shopId
              : null,
          ),
        )
      ).filter((shopId): shopId is string => shopId !== null),
    );
    const actionableConversations = conversations.filter(
      (conversation) =>
        conversation.checkoutRecovery?.shopId !== undefined &&
        activeShopIds.has(conversation.checkoutRecovery.shopId),
    );
    if (actionableConversations.length === 0) {
      return { kind: "shop-unavailable", customerPhone };
    }

    const ownershipPairs = new Map<
      string,
      { shopId: string; customerId: string }
    >();
    for (const conversation of actionableConversations) {
      const recovery = conversation.checkoutRecovery;
      const customerId = recovery?.customer?.id;
      if (!recovery?.shopId || !customerId) {
        return {
          kind: "unresolved",
          reason: "ambiguous-tenant",
          customerPhone,
        };
      }
      ownershipPairs.set(`${recovery.shopId}:${customerId}`, {
        shopId: recovery.shopId,
        customerId,
      });
    }
    if (ownershipPairs.size !== 1) {
      return { kind: "unresolved", reason: "ambiguous-tenant", customerPhone };
    }
    const ownership = [...ownershipPairs.values()][0];
    if (!ownership) {
      return { kind: "unresolved", reason: "ambiguous-tenant", customerPhone };
    }

    return {
      kind: "clarify",
      conversationId: await this.getOrCreateStandaloneConversation({
        shopId: ownership.shopId,
        customerId: ownership.customerId,
        type: "PRODUCT_SUPPORT",
      }),
      customerPhone,
      shopId: ownership.shopId,
      customerId: ownership.customerId,
      recoveries: actionableConversations.map((conversation) => {
        if (!conversation.checkoutRecovery) {
          throw new Error(
            "Recovery conversation is missing its checkout recovery",
          );
        }

        return {
          id: conversation.checkoutRecovery.id,
          checkoutToken: conversation.checkoutRecovery.checkoutToken,
          status: conversation.checkoutRecovery.status,
          totalPrice:
            conversation.checkoutRecovery.totalPrice?.toString() ?? null,
        };
      }),
    };
  }

  private async getOrCreateStandaloneConversation({
    shopId,
    customerId,
    type,
  }: {
    shopId: string;
    customerId: string;
    type: StandaloneConversationType;
  }): Promise<string> {
    if (!shopId || !customerId) {
      throw new Error(
        "Standalone conversation requires shop and customer ownership",
      );
    }

    const standaloneScopeKey = `standalone:${shopId}:${customerId}:${type}`;
    const staleBefore = new Date(Date.now() - STANDALONE_CONVERSATION_TTL_MS);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await prisma.$transaction(async (transaction) => {
          const existing = await transaction.conversation.findUnique({
            where: { standaloneScopeKey },
            select: {
              id: true,
              outcome: true,
              lastMessageAt: true,
              createdAt: true,
            },
          });

          const lastActivity = existing?.lastMessageAt ?? existing?.createdAt;
          if (
            existing &&
            existing.outcome === "IN_PROGRESS" &&
            lastActivity &&
            lastActivity >= staleBefore
          ) {
            return existing.id;
          }

          if (existing) {
            await transaction.conversation.updateMany({
              where: { id: existing.id, standaloneScopeKey },
              data: { outcome: "EXPIRED", standaloneScopeKey: null },
            });
          }

          const created = await transaction.conversation.create({
            data: {
              shopId,
              customerId,
              standaloneScopeKey,
              type,
              outcome: "IN_PROGRESS",
            },
            select: { id: true },
          });
          return created.id;
        });
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== "P2002" ||
          attempt === 2
        ) {
          throw error;
        }
      }
    }

    throw new Error("Unable to resolve standalone conversation");
  }
  private async resolveProductOnlyCustomer(
    customerPhone: string,
  ): Promise<RecoveryRoute> {
    const normalizedPhone = customerPhone.trim();

    const activeCustomerPhones = await prisma.customerPhone.findMany({
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
      take: 11,
    });

    if (activeCustomerPhones.length === 11) {
      return { kind: "unresolved", reason: "ambiguous-tenant", customerPhone };
    }

    const ownershipPairs = new Map<
      string,
      { shopId: string; customerId: string; domain: string }
    >();
    for (const customerPhoneRecord of activeCustomerPhones) {
      const customer = customerPhoneRecord.customer;
      if (!customer) continue;
      ownershipPairs.set(
        `${customer.shopId}:${customerPhoneRecord.customerId}`,
        {
          shopId: customer.shopId,
          customerId: customerPhoneRecord.customerId,
          domain: customer.shop.domain,
        },
      );
    }

    if (ownershipPairs.size === 0) {
      return {
        kind: "product-only",
        customerPhone,
        type: "PRODUCT_DISCOVERY",
      };
    }

    const activeOwnerships = (
      await Promise.all(
        [...ownershipPairs.values()].map(async (ownership) =>
          (await shopExecutionEligibilityService.isShopExecutionActive(
            ownership.shopId,
          ))
            ? ownership
            : null,
        ),
      )
    ).filter((ownership): ownership is NonNullable<typeof ownership> => ownership !== null);
    if (activeOwnerships.length === 0) {
      return { kind: "shop-unavailable", customerPhone };
    }
    if (activeOwnerships.length !== 1) {
      return { kind: "unresolved", reason: "ambiguous-tenant", customerPhone };
    }
    const ownership = activeOwnerships[0];
    if (!ownership) {
      return { kind: "unresolved", reason: "ambiguous-tenant", customerPhone };
    }

    const conversationId = await this.getOrCreateStandaloneConversation({
      shopId: ownership.shopId,
      customerId: ownership.customerId,
      type: "PRODUCT_DISCOVERY",
    });

    return {
      kind: "product-only",
      customerPhone,
      shop: ownership.domain,
      shopId: ownership.shopId,
      customerId: ownership.customerId,
      conversationId,
      type: "PRODUCT_DISCOVERY",
    };
  }
}

export const recoveryRoutingService = new RecoveryRoutingService();
