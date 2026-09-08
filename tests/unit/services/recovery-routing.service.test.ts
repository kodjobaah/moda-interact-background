import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

import prisma from "../../../src/lib/db.js";
import { ConversationService } from "../../../src/services/conversation.service.js";
import { RecoveryRoutingService } from "../../../src/services/recovery-routing.service.js";

vi.mock("../../../src/lib/db.js", () => ({
  default: {
    conversationMessage: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    conversation: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
    },
    customerPhone: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

describe("RecoveryRoutingService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns product-only when the customer has no active checkout recoveries", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([]);
    vi.mocked(prisma.customerPhone.findMany).mockResolvedValue([]);

    const service = new RecoveryRoutingService();
    const route = await service.resolveInboundMessage({
      provider: "whatsapp",
      providerMessageId: "msg-1",
      customerPhone: "+447700900000",
      contextMessageId: null,
      phoneNumberId: "phone-1",
      timestamp: Date.now(),
      type: "text",
      text: "Do you have this in black?",
    });

    expect(route).toMatchObject({
      kind: "product-only",
      customerPhone: "+447700900000",
    });
  });

  it("reuses an active standalone conversation for product turns", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([]);
    vi.mocked(prisma.customerPhone.findMany).mockResolvedValue([
      {
        customerId: "customer-1",
        customer: {
          shopId: "shop-1",
          shop: { domain: "example.myshopify.com" },
        },
      },
    ] as any);
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "standalone-1",
        outcome: "IN_PROGRESS",
        createdAt: new Date(),
        lastMessageAt: new Date(),
      });
    const create = vi.fn().mockResolvedValue({ id: "standalone-1" });
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) =>
      callback({
        conversation: { findUnique, create, updateMany: vi.fn() },
      }),
    );

    const service = new RecoveryRoutingService();
    const first = await service.resolveInboundMessage({
      provider: "whatsapp",
      providerMessageId: "product-1",
      customerPhone: "+447700900000",
      contextMessageId: null,
      phoneNumberId: "phone-1",
      timestamp: Date.now(),
      type: "text",
      text: "Show me shirts",
    });
    const second = await service.resolveInboundMessage({
      provider: "whatsapp",
      providerMessageId: "product-2",
      customerPhone: "+447700900000",
      contextMessageId: null,
      phoneNumberId: "phone-1",
      timestamp: Date.now(),
      type: "text",
      text: "In black",
    });

    expect(first).toMatchObject({
      kind: "product-only",
      conversationId: "standalone-1",
    });
    expect(second).toMatchObject({
      kind: "product-only",
      conversationId: "standalone-1",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("expires an inactive standalone scope before creating a new lifecycle", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([]);
    vi.mocked(prisma.customerPhone.findMany).mockResolvedValue([
      {
        customerId: "customer-1",
        customer: { shopId: "shop-1", shop: { domain: "one.myshopify.com" } },
      },
    ] as any);
    const updateMany = vi.fn();
    const create = vi.fn().mockResolvedValue({ id: "standalone-new" });
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) =>
      callback({
        conversation: {
          findUnique: vi.fn().mockResolvedValue({
            id: "standalone-old",
            outcome: "IN_PROGRESS",
            createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
            lastMessageAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
          }),
          create,
          updateMany,
        },
      }),
    );

    const route = await new RecoveryRoutingService().resolveInboundMessage({
      provider: "whatsapp",
      providerMessageId: "expired-product",
      customerPhone: "+447700900000",
      contextMessageId: null,
      phoneNumberId: "phone-1",
      timestamp: Date.now(),
      type: "text",
      text: "Show me shirts",
    });

    expect(route).toMatchObject({
      kind: "product-only",
      conversationId: "standalone-new",
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "standalone-old",
        standaloneScopeKey: "standalone:shop-1:customer-1:PRODUCT_DISCOVERY",
      },
      data: { outcome: "EXPIRED", standaloneScopeKey: null },
    });
  });

  it("re-reads and reuses the winner after a standalone uniqueness race", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([]);
    vi.mocked(prisma.customerPhone.findMany).mockResolvedValue([
      {
        customerId: "customer-1",
        customer: { shopId: "shop-1", shop: { domain: "one.myshopify.com" } },
      },
    ] as any);
    const findUniqueFirst = vi.fn().mockResolvedValue(null);
    const findUniqueWinner = vi.fn().mockResolvedValue({
      id: "standalone-winner",
      outcome: "IN_PROGRESS",
      createdAt: new Date(),
      lastMessageAt: new Date(),
    });
    const create = vi.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "6.19.3",
      }),
    );
    vi.mocked(prisma.$transaction)
      .mockImplementationOnce(async (callback: any) =>
        callback({
          conversation: {
            findUnique: findUniqueFirst,
            create,
            updateMany: vi.fn(),
          },
        }),
      )
      .mockImplementationOnce(async (callback: any) =>
        callback({
          conversation: {
            findUnique: findUniqueWinner,
            create,
            updateMany: vi.fn(),
          },
        }),
      );

    const route = await new RecoveryRoutingService().resolveInboundMessage({
      provider: "whatsapp",
      providerMessageId: "race-product",
      customerPhone: "+447700900000",
      contextMessageId: null,
      phoneNumberId: "phone-1",
      timestamp: Date.now(),
      type: "text",
      text: "Show me shirts",
    });

    expect(route).toMatchObject({
      kind: "product-only",
      conversationId: "standalone-winner",
    });
  });

  it("fails closed when a phone belongs to multiple merchant ownership pairs", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([]);
    vi.mocked(prisma.customerPhone.findMany).mockResolvedValue([
      {
        customerId: "customer-1",
        customer: { shopId: "shop-1", shop: { domain: "one.myshopify.com" } },
      },
      {
        customerId: "customer-2",
        customer: { shopId: "shop-2", shop: { domain: "two.myshopify.com" } },
      },
    ] as any);

    const route = await new RecoveryRoutingService().resolveInboundMessage({
      provider: "whatsapp",
      providerMessageId: "ambiguous-product",
      customerPhone: "+447700900000",
      contextMessageId: null,
      phoneNumberId: "phone-1",
      timestamp: Date.now(),
      type: "text",
      text: "Show me shirts",
    });

    expect(route).toEqual({
      kind: "unresolved",
      reason: "ambiguous-tenant",
      customerPhone: "+447700900000",
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("fails closed when the product phone lookup reaches its overflow sentinel", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([]);
    vi.mocked(prisma.customerPhone.findMany).mockResolvedValue([
      ...Array.from({ length: 10 }, (_, index) => ({
        customerId: `customer-${index}`,
        customer: { shopId: "shop-1", shop: { domain: "one.myshopify.com" } },
      })),
      {
        customerId: "customer-other",
        customer: { shopId: "shop-2", shop: { domain: "two.myshopify.com" } },
      },
    ] as any);

    const route = await new RecoveryRoutingService().resolveInboundMessage({
      provider: "whatsapp",
      providerMessageId: "overflow-product",
      customerPhone: "+447700900000",
      contextMessageId: null,
      phoneNumberId: "phone-1",
      timestamp: Date.now(),
      type: "text",
      text: "Show me shirts",
    });

    expect(route).toEqual({
      kind: "unresolved",
      reason: "ambiguous-tenant",
      customerPhone: "+447700900000",
    });
    expect(prisma.customerPhone.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 11 }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("deduplicates duplicate active phone rows for one ownership pair", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([]);
    vi.mocked(prisma.customerPhone.findMany).mockResolvedValue([
      {
        customerId: "customer-1",
        customer: { shopId: "shop-1", shop: { domain: "one.myshopify.com" } },
      },
      {
        customerId: "customer-1",
        customer: { shopId: "shop-1", shop: { domain: "one.myshopify.com" } },
      },
    ] as any);
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) =>
      callback({
        conversation: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "standalone-1" }),
          updateMany: vi.fn(),
        },
      }),
    );

    const route = await new RecoveryRoutingService().resolveInboundMessage({
      provider: "whatsapp",
      providerMessageId: "duplicate-product",
      customerPhone: "+447700900000",
      contextMessageId: null,
      phoneNumberId: "phone-1",
      timestamp: Date.now(),
      type: "text",
      text: "Show me shirts",
    });

    expect(route).toMatchObject({
      kind: "product-only",
      conversationId: "standalone-1",
    });
  });

  it("returns the only active recovery when there is exactly one match", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([
      {
        id: "conversation-1",
        checkoutRecoveryId: "recovery-1",
        checkoutRecovery: {
          id: "recovery-1",
          shopId: "shop-1",
          status: "ENGAGED",
          checkoutToken: "checkout-1",
          totalPrice: "42.00",
          customer: {
            id: "customer-1",
            phone: "+447700900000",
          },
        },
      },
    ] as any);

    const service = new RecoveryRoutingService();
    const route = await service.resolveInboundMessage({
      provider: "whatsapp",
      providerMessageId: "msg-2",
      customerPhone: "+447700900000",
      contextMessageId: null,
      phoneNumberId: "phone-1",
      timestamp: Date.now(),
      type: "text",
      text: "Can you tell me if the red one is still available?",
    });

    expect(route).toMatchObject({
      kind: "resolved",
      conversationId: "conversation-1",
      checkoutRecoveryId: "recovery-1",
    });
  });

  it("asks for clarification when the customer has multiple active recoveries", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([
      {
        id: "conversation-1",
        checkoutRecoveryId: "recovery-1",
        checkoutRecovery: {
          id: "recovery-1",
          shopId: "shop-1",
          status: "ENGAGED",
          checkoutToken: "checkout-1",
          totalPrice: "42.00",
          customer: {
            id: "customer-1",
            phone: "+447700900000",
          },
        },
      },
      {
        id: "conversation-2",
        checkoutRecoveryId: "recovery-2",
        checkoutRecovery: {
          id: "recovery-2",
          shopId: "shop-1",
          status: "MESSAGE_SENT",
          checkoutToken: "checkout-2",
          totalPrice: "18.00",
          customer: {
            id: "customer-1",
            phone: "+447700900000",
          },
        },
      },
    ] as any);
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) =>
      callback({
        conversation: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "standalone-1" }),
          updateMany: vi.fn(),
        },
      }),
    );

    const service = new RecoveryRoutingService();
    const route = await service.resolveInboundMessage({
      provider: "whatsapp",
      providerMessageId: "msg-3",
      customerPhone: "+447700900000",
      contextMessageId: null,
      phoneNumberId: "phone-1",
      timestamp: Date.now(),
      type: "text",
      text: "I want to know more about the basket?",
    });

    expect(route).toMatchObject({
      kind: "clarify",
      conversationId: "standalone-1",
      customerPhone: "+447700900000",
    });
    expect((route as any).recoveries).toHaveLength(2);
  });

  it("fails closed when the active recovery lookup reaches its overflow sentinel", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue(
      Array.from({ length: 11 }, (_, index) => ({
        id: `conversation-${index}`,
        checkoutRecoveryId: `recovery-${index}`,
        checkoutRecovery: {
          id: `recovery-${index}`,
          shopId: index === 10 ? "shop-2" : "shop-1",
          status: "ENGAGED",
          checkoutToken: `checkout-${index}`,
          totalPrice: "42.00",
          customer: {
            id: index === 10 ? "customer-2" : "customer-1",
            phone: "+447700900000",
          },
        },
      })) as any,
    );

    const route = await new RecoveryRoutingService().resolveInboundMessage({
      provider: "whatsapp",
      providerMessageId: "overflow-recovery",
      customerPhone: "+447700900000",
      contextMessageId: null,
      phoneNumberId: "phone-1",
      timestamp: Date.now(),
      type: "text",
      text: "Which basket?",
    });

    expect(route).toEqual({
      kind: "unresolved",
      reason: "ambiguous-tenant",
      customerPhone: "+447700900000",
    });
    expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 11 }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("allows exactly ten same-owner product phone rows", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([]);
    vi.mocked(prisma.customerPhone.findMany).mockResolvedValue(
      Array.from({ length: 10 }, () => ({
        customerId: "customer-1",
        customer: { shopId: "shop-1", shop: { domain: "one.myshopify.com" } },
      })) as any,
    );
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) =>
      callback({
        conversation: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "standalone-10" }),
          updateMany: vi.fn(),
        },
      }),
    );

    const route = await new RecoveryRoutingService().resolveInboundMessage({
      provider: "whatsapp",
      providerMessageId: "ten-product",
      customerPhone: "+447700900000",
      contextMessageId: null,
      phoneNumberId: "phone-1",
      timestamp: Date.now(),
      type: "text",
      text: "Show me shirts",
    });

    expect(route).toMatchObject({
      kind: "product-only",
      conversationId: "standalone-10",
    });
    expect(prisma.customerPhone.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 11 }),
    );
  });

  it("allows exactly ten same-owner active recoveries", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => ({
        id: `conversation-${index}`,
        checkoutRecoveryId: `recovery-${index}`,
        checkoutRecovery: {
          id: `recovery-${index}`,
          shopId: "shop-1",
          status: "ENGAGED",
          checkoutToken: `checkout-${index}`,
          totalPrice: "42.00",
          customer: { id: "customer-1", phone: "+447700900000" },
        },
      })) as any,
    );
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) =>
      callback({
        conversation: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "clarification-10" }),
          updateMany: vi.fn(),
        },
      }),
    );

    const route = await new RecoveryRoutingService().resolveInboundMessage({
      provider: "whatsapp",
      providerMessageId: "ten-recoveries",
      customerPhone: "+447700900000",
      contextMessageId: null,
      phoneNumberId: "phone-1",
      timestamp: Date.now(),
      type: "text",
      text: "Which basket?",
    });

    expect(route).toMatchObject({
      kind: "clarify",
      conversationId: "clarification-10",
    });
    expect((route as any).recoveries).toHaveLength(10);
    expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 11 }),
    );
  });

  it("fails closed when active recoveries span merchant ownership pairs", async () => {
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([
      {
        id: "conversation-1",
        checkoutRecoveryId: "recovery-1",
        checkoutRecovery: {
          id: "recovery-1",
          shopId: "shop-1",
          status: "ENGAGED",
          checkoutToken: "checkout-1",
          totalPrice: "42.00",
          customer: { id: "customer-1", phone: "+447700900000" },
        },
      },
      {
        id: "conversation-2",
        checkoutRecoveryId: "recovery-2",
        checkoutRecovery: {
          id: "recovery-2",
          shopId: "shop-2",
          status: "MESSAGE_SENT",
          checkoutToken: "checkout-2",
          totalPrice: "18.00",
          customer: { id: "customer-2", phone: "+447700900000" },
        },
      },
    ] as any);

    const route = await new RecoveryRoutingService().resolveInboundMessage({
      provider: "whatsapp",
      providerMessageId: "ambiguous-recovery",
      customerPhone: "+447700900000",
      contextMessageId: null,
      phoneNumberId: "phone-1",
      timestamp: Date.now(),
      type: "text",
      text: "Which basket?",
    });

    expect(route).toEqual({
      kind: "unresolved",
      reason: "ambiguous-tenant",
      customerPhone: "+447700900000",
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("reuses the same clarification conversation for one owner within 24 hours", async () => {
    const recoveries = [
      {
        id: "conversation-1",
        checkoutRecoveryId: "recovery-1",
        checkoutRecovery: {
          id: "recovery-1",
          shopId: "shop-1",
          status: "ENGAGED",
          checkoutToken: "checkout-1",
          totalPrice: "42.00",
          customer: { id: "customer-1", phone: "+447700900000" },
        },
      },
      {
        id: "conversation-2",
        checkoutRecoveryId: "recovery-2",
        checkoutRecovery: {
          id: "recovery-2",
          shopId: "shop-1",
          status: "MESSAGE_SENT",
          checkoutToken: "checkout-2",
          totalPrice: "18.00",
          customer: { id: "customer-1", phone: "+447700900000" },
        },
      },
    ];
    vi.mocked(prisma.conversation.findMany).mockResolvedValue(
      recoveries as any,
    );
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "clarification-1",
        outcome: "IN_PROGRESS",
        createdAt: new Date(),
        lastMessageAt: new Date(),
      });
    const create = vi.fn().mockResolvedValue({ id: "clarification-1" });
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) =>
      callback({ conversation: { findUnique, create, updateMany: vi.fn() } }),
    );

    const service = new RecoveryRoutingService();
    const input = {
      provider: "whatsapp" as const,
      customerPhone: "+447700900000",
      contextMessageId: null,
      phoneNumberId: "phone-1",
      timestamp: Date.now(),
      type: "text" as const,
      text: "Which basket?",
    };
    const first = await service.resolveInboundMessage({
      ...input,
      providerMessageId: "clarify-1",
    });
    const second = await service.resolveInboundMessage({
      ...input,
      providerMessageId: "clarify-2",
    });

    expect(first).toMatchObject({
      kind: "clarify",
      conversationId: "clarification-1",
    });
    expect(second).toMatchObject({
      kind: "clarify",
      conversationId: "clarification-1",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("reconstructs one current recovery for a settled clarification conversation", async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue({
      type: "PRODUCT_SUPPORT",
      shopId: "shop-1",
      customerId: "customer-1",
      customer: { phone: "+447700900000" },
    } as any);
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([
      {
        checkoutRecovery: {
          id: "recovery-current",
          shopId: "shop-1",
          customer: { id: "customer-1", phone: "+447700900000" },
          checkoutToken: "checkout-current",
          totalPrice: "42.00",
        },
      },
    ] as any);

    await expect(
      new RecoveryRoutingService().getCurrentClarification("clarification-1"),
    ).resolves.toEqual({
      kind: "resolved",
      shopId: "shop-1",
      customerPhone: "+447700900000",
      checkoutRecoveryId: "recovery-current",
    });
  });

  it("fails closed when a resolved recovery does not match the clarification owner", async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue({
      type: "PRODUCT_SUPPORT",
      shopId: "shop-1",
      customerId: "customer-1",
      customer: { phone: "+447700900000" },
    } as any);
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([
      {
        checkoutRecovery: {
          id: "recovery-other-tenant",
          shopId: "shop-2",
          customer: { id: "customer-2", phone: "+447700900000" },
          checkoutToken: "checkout-other-tenant",
          totalPrice: "42.00",
        },
      },
    ] as any);

    await expect(
      new RecoveryRoutingService().getCurrentClarification("clarification-1"),
    ).resolves.toEqual({
      kind: "unresolved",
      reason: "ambiguous-tenant",
      customerPhone: "+447700900000",
    });
  });

  it("persists three clarification fragments before reconstructing one current turn", async () => {
    const persisted = vi.fn();
    vi.mocked(prisma.conversation.findUniqueOrThrow).mockResolvedValue({
      inboundVersion: 0,
      lastProcessedVersion: 0,
      pendingTurnStartedAt: null,
      languageTag: null,
      languageSource: null,
    } as any);
    vi.mocked(prisma.conversationMessage.findUnique)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) =>
      callback({
        conversationMessage: { create: persisted },
        conversation: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          update: vi
            .fn()
            .mockResolvedValueOnce({ id: "clarification-1", inboundVersion: 1 })
            .mockResolvedValueOnce({ id: "clarification-1", inboundVersion: 2 })
            .mockResolvedValueOnce({
              id: "clarification-1",
              inboundVersion: 3,
            }),
        },
      }),
    );
    const conversationService = new ConversationService();
    for (const [index, content] of [
      "Which basket?",
      "The jacket one",
      "The blue one",
    ].entries()) {
      await conversationService.receiveMessage({
        conversationId: "clarification-1",
        providerMessageId: `clarification-${index}`,
        inReplyToProviderId: null,
        content,
      });
    }

    vi.mocked(prisma.conversation.findUnique).mockResolvedValue({
      type: "PRODUCT_SUPPORT",
      shopId: "shop-1",
      customerId: "customer-1",
      customer: { phone: "+447700900000" },
    } as any);
    vi.mocked(prisma.conversation.findMany).mockResolvedValue([
      {
        checkoutRecovery: {
          id: "recovery-1",
          shopId: "shop-1",
          customer: { id: "customer-1", phone: "+447700900000" },
          checkoutToken: "checkout-1",
          totalPrice: "42.00",
        },
      },
      {
        checkoutRecovery: {
          id: "recovery-2",
          shopId: "shop-1",
          customer: { id: "customer-1", phone: "+447700900000" },
          checkoutToken: "checkout-2",
          totalPrice: "18.00",
        },
      },
    ] as any);

    const route = await new RecoveryRoutingService().getCurrentClarification(
      "clarification-1",
    );

    expect(persisted).toHaveBeenCalledTimes(3);
    expect(route).toMatchObject({ kind: "clarify" });
  });

  it("fails closed for current recovery overflow and mixed ownership", async () => {
    vi.mocked(prisma.conversation.findUnique).mockResolvedValue({
      type: "PRODUCT_SUPPORT",
      shopId: "shop-1",
      customerId: "customer-1",
      customer: { phone: "+447700900000" },
    } as any);
    vi.mocked(prisma.conversation.findMany).mockResolvedValue(
      Array.from({ length: 11 }, (_, index) => ({
        checkoutRecovery: {
          id: `recovery-${index}`,
          shopId: "shop-1",
          customer: { id: "customer-1", phone: "+447700900000" },
          checkoutToken: `checkout-${index}`,
          totalPrice: "42.00",
        },
      })) as any,
    );

    await expect(
      new RecoveryRoutingService().getCurrentClarification("clarification-1"),
    ).resolves.toMatchObject({ kind: "unresolved", reason: "overflow" });

    vi.mocked(prisma.conversation.findMany).mockResolvedValue([
      {
        checkoutRecovery: {
          id: "recovery-1",
          shopId: "shop-1",
          customer: { id: "customer-1", phone: "+447700900000" },
          checkoutToken: "checkout-1",
          totalPrice: "42.00",
        },
      },
      {
        checkoutRecovery: {
          id: "recovery-2",
          shopId: "shop-2",
          customer: { id: "customer-2", phone: "+447700900000" },
          checkoutToken: "checkout-2",
          totalPrice: "18.00",
        },
      },
    ] as any);

    await expect(
      new RecoveryRoutingService().getCurrentClarification("clarification-1"),
    ).resolves.toMatchObject({
      kind: "unresolved",
      reason: "ambiguous-tenant",
    });
  });
});
