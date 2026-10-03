import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  conversationMessage: { findUnique: vi.fn() },
  conversation: { findUnique: vi.fn(), findMany: vi.fn() },
  customerPhone: { findFirst: vi.fn(), findMany: vi.fn() },
  customer: { findUnique: vi.fn(), findMany: vi.fn() },
}));
const active = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/db.js", () => ({ default: db }));
vi.mock("../../../src/services/shop-execution-eligibility.service.js", () => ({
  shopExecutionEligibilityService: { isShopExecutionActive: active },
}));
vi.mock("../../../src/services/whatsapp.service.js", () => ({
  whatsAppService: {
    resolveSender: () => ({
      providerAccountId: "waba",
      providerPhoneNumberId: "phone",
    }),
  },
}));

import { WhatsAppConversationRoutingService } from "../../../src/services/whatsapp-conversation-routing.service.js";

const event = {
  schemaVersion: 1,
  provider: "whatsapp",
  providerAccountId: "waba",
  providerPhoneNumberId: "phone",
  providerMessageId: "incoming",
  customerPhone: "+4477",
  contextMessageId: null,
  occurredAt: "2026-09-20T12:00:00Z",
  content: { type: "text", text: "help" },
} as const;

beforeEach(() => {
  vi.resetAllMocks();
  active.mockResolvedValue(true);
  db.conversationMessage.findUnique.mockResolvedValue(null);
  db.customerPhone.findMany.mockResolvedValue([
    { customer: { id: "customer-1", shopId: "shop-1" } },
  ]);
  db.customerPhone.findFirst.mockResolvedValue({ id: "phone-row-1" });
  db.customer.findMany.mockResolvedValue([]);
  db.customer.findUnique.mockResolvedValue({ phone: "+4477" });
  db.conversation.findMany.mockResolvedValue([{ id: "conversation-1" }]);
  db.conversation.findUnique.mockResolvedValue({
    shopId: null,
    customerId: null,
    checkoutRecovery: { shopId: "shop-1", customerId: "customer-1" },
  });
});

describe("WhatsAppConversationRoutingService", () => {
  it("rejects the wrong Meta sender before database access", async () => {
    await expect(
      new WhatsAppConversationRoutingService().resolveInboundMessage({
        ...event,
        providerAccountId: "other",
      }),
    ).resolves.toEqual({ kind: "ignored" });

    expect(db.conversationMessage.findUnique).not.toHaveBeenCalled();
  });

  it("reuses an already-persisted inbound message conversation before inference", async () => {
    db.conversationMessage.findUnique.mockResolvedValue({
      direction: "INBOUND",
      conversationId: "stored-conversation",
    });

    await expect(
      new WhatsAppConversationRoutingService().resolveInboundMessage(event),
    ).resolves.toEqual({
      kind: "resolved",
      conversationId: "stored-conversation",
      shopId: "shop-1",
      customerId: "customer-1",
    });

    expect(db.customerPhone.findMany).not.toHaveBeenCalled();
    expect(db.conversation.findMany).not.toHaveBeenCalled();
  });

  it("uses explicit reply context to resolve an existing recovery conversation", async () => {
    db.conversationMessage.findUnique.mockImplementation(async ({ where }) =>
      where.providerMessageId === "old"
        ? {
            direction: "OUTBOUND",
            sentAt: new Date(),
            conversationId: "reply-conversation",
          }
        : null,
    );

    await expect(
      new WhatsAppConversationRoutingService().resolveInboundMessage({
        ...event,
        contextMessageId: "old",
      }),
    ).resolves.toEqual({
      kind: "resolved",
      conversationId: "reply-conversation",
      shopId: "shop-1",
      customerId: "customer-1",
    });

    expect(db.customerPhone.findMany).not.toHaveBeenCalled();
  });

  it("recognizes standalone conversation ownership but keeps execution gated until C", async () => {
    db.conversationMessage.findUnique.mockImplementation(async ({ where }) =>
      where.providerMessageId === "old"
        ? {
            direction: "OUTBOUND",
            sentAt: new Date(),
            conversationId: "standalone-conversation",
          }
        : null,
    );
    db.conversation.findUnique.mockResolvedValue({
      shopId: "shop-1",
      customerId: "customer-1",
      checkoutRecovery: null,
    });

    await expect(
      new WhatsAppConversationRoutingService().resolveInboundMessage({
        ...event,
        contextMessageId: "old",
      }),
    ).resolves.toEqual({ kind: "guidance", reason: "CONTEXT_REQUIRED" });
  });

  it("never falls back from an invalid explicit reply reference", async () => {
    db.conversationMessage.findUnique.mockImplementation(async ({ where }) =>
      where.providerMessageId === "bad"
        ? { direction: "OUTBOUND", sentAt: null, conversationId: "c1" }
        : null,
    );

    await expect(
      new WhatsAppConversationRoutingService().resolveInboundMessage({
        ...event,
        contextMessageId: "bad",
      }),
    ).resolves.toEqual({ kind: "guidance", reason: "INVALID_REFERENCE" });

    expect(db.customerPhone.findMany).not.toHaveBeenCalled();
    expect(active).not.toHaveBeenCalled();
  });

  it("rejects disagreement between stored inbound ownership and explicit reply context", async () => {
    db.conversationMessage.findUnique.mockImplementation(async ({ where }) =>
      where.providerMessageId === "incoming"
        ? { direction: "INBOUND", conversationId: "stored-conversation" }
        : {
            direction: "OUTBOUND",
            sentAt: new Date(),
            conversationId: "different-conversation",
          },
    );

    await expect(
      new WhatsAppConversationRoutingService().resolveInboundMessage({
        ...event,
        contextMessageId: "old",
      }),
    ).resolves.toEqual({ kind: "guidance", reason: "INVALID_REFERENCE" });
  });

  it("resolves an unthreaded message only after one tenant/customer owner and one recovery conversation are established", async () => {
    await expect(
      new WhatsAppConversationRoutingService().resolveInboundMessage(event),
    ).resolves.toEqual({
      kind: "resolved",
      conversationId: "conversation-1",
      shopId: "shop-1",
      customerId: "customer-1",
    });

    expect(db.customerPhone.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 11 }),
    );
    expect(db.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          checkoutRecovery: {
            is: { shopId: "shop-1", customerId: "customer-1" },
          },
        }),
        take: 2,
      }),
    );
  });

  it("deduplicates repeated active phone rows for one owner before recovery resolution", async () => {
    db.customerPhone.findMany.mockResolvedValue([
      { customer: { id: "customer-1", shopId: "shop-1" } },
      { customer: { id: "customer-1", shopId: "shop-1" } },
    ]);

    await expect(
      new WhatsAppConversationRoutingService().resolveInboundMessage(event),
    ).resolves.toMatchObject({ kind: "resolved", shopId: "shop-1" });
  });

  it("fails closed before eligibility when current phone ownership spans merchants", async () => {
    db.customerPhone.findMany.mockResolvedValue([
      { customer: { id: "customer-1", shopId: "shop-1" } },
      { customer: { id: "customer-2", shopId: "shop-2" } },
    ]);

    await expect(
      new WhatsAppConversationRoutingService().resolveInboundMessage(event),
    ).resolves.toEqual({ kind: "guidance", reason: "AMBIGUOUS_OWNER" });

    expect(db.conversation.findMany).not.toHaveBeenCalled();
    expect(active).not.toHaveBeenCalled();
  });

  it("uses an overflow sentinel for phone ownership and fails closed", async () => {
    db.customerPhone.findMany.mockResolvedValue(
      Array.from({ length: 11 }, (_, index) => ({
        customer: { id: `customer-${index}`, shopId: "shop-1" },
      })),
    );

    await expect(
      new WhatsAppConversationRoutingService().resolveInboundMessage(event),
    ).resolves.toEqual({ kind: "guidance", reason: "AMBIGUOUS_OWNER" });

    expect(db.conversation.findMany).not.toHaveBeenCalled();
  });

  it("distinguishes unknown ownership from missing/ambiguous business context", async () => {
    db.customerPhone.findMany.mockResolvedValue([]);
    db.customer.findMany.mockResolvedValue([]);
    await expect(
      new WhatsAppConversationRoutingService().resolveInboundMessage(event),
    ).resolves.toEqual({ kind: "guidance", reason: "UNKNOWN_OWNER" });

    db.customerPhone.findMany.mockResolvedValue([
      { customer: { id: "customer-1", shopId: "shop-1" } },
    ]);
    db.conversation.findMany.mockResolvedValue([]);
    await expect(
      new WhatsAppConversationRoutingService().resolveInboundMessage(event),
    ).resolves.toEqual({ kind: "guidance", reason: "CONTEXT_REQUIRED" });

    db.conversation.findMany.mockResolvedValue([
      { id: "recovery-conversation-1" },
      { id: "recovery-conversation-2" },
    ]);
    await expect(
      new WhatsAppConversationRoutingService().resolveInboundMessage(event),
    ).resolves.toEqual({ kind: "guidance", reason: "CONTEXT_REQUIRED" });
  });

  it("checks shop execution only after owner/conversation resolution", async () => {
    active.mockResolvedValue(false);

    await expect(
      new WhatsAppConversationRoutingService().resolveInboundMessage(event),
    ).resolves.toEqual({ kind: "guidance", reason: "SHOP_UNAVAILABLE" });
  });
});
