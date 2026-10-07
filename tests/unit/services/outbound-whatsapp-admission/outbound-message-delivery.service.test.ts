import { describe, expect, it, vi } from "vitest";

import {
  OutboundMessageDeliveryService,
  TERMINAL_MESSAGE,
} from "../../../../src/services/outbound-whatsapp-admission/outbound-message-delivery.service.js";

function harness({
  provider = {},
  executionEligibility = {
    evaluate: vi.fn(async () => ({ allowed: true as const, shopId: "shop-1" })),
  },
}: {
  provider?: Record<string, unknown>;
  executionEligibility?: { evaluate: ReturnType<typeof vi.fn> };
} = {}) {
  const conversationMessageUpdate = vi.fn().mockResolvedValue({});
  const conversationMessageFindUnique = vi
    .fn()
    .mockResolvedValue({ conversationId: "conversation-1" });
  const conversationUpdate = vi.fn().mockResolvedValue({});
  const usageDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const transaction = {
    conversationMessage: {
      update: conversationMessageUpdate,
      findUnique: conversationMessageFindUnique,
    },
    conversation: { update: conversationUpdate },
  };
  const database = {
    $transaction: vi.fn().mockImplementation(async (operation: unknown) =>
      typeof operation === "function" ? operation(transaction) : undefined,
    ),
    conversationMessage: { update: conversationMessageUpdate },
    usageEvent: { deleteMany: usageDeleteMany },
    conversation: { update: conversationUpdate },
  };
  const providerMock = {
    getProviderAccountId: vi.fn().mockReturnValue("phone-number-id"),
    sendWhatsAppText: vi.fn().mockResolvedValue({ providerMessageId: "wamid-1" }),
    sendWhatsAppTemplate: vi
      .fn()
      .mockResolvedValue({ providerMessageId: "wamid-template" }),
    ...provider,
  };

  return {
    database,
    transaction,
    providerMock,
    executionEligibility,
    service: new OutboundMessageDeliveryService(
      database as never,
      providerMock as never,
      executionEligibility as never,
    ),
  };
}

const admission = {
  kind: "admitted" as const,
  shopId: "shop-1",
  messageId: "message-1",
  conversationId: "conversation-1",
  terminal: false,
  executionScope: "general" as const,
};

describe("OutboundMessageDeliveryService", () => {
  it("delegates provider account identity", () => {
    const test = harness();

    expect(test.service.getProviderAccountId()).toBe("phone-number-id");
    expect(test.providerMock.getProviderAccountId).toHaveBeenCalledOnce();
  });

  it("revalidates and forwards prepared text context before persisting SENT", async () => {
    const test = harness();

    await expect(
      test.service.sendPreparedText({
        ...admission,
        to: "+15551234567",
        text: "Hello",
        previewUrl: true,
        replyToProviderMessageId: "wamid-inbound",
      }),
    ).resolves.toMatchObject({ kind: "admitted", terminal: false });

    expect(test.executionEligibility.evaluate).toHaveBeenCalledWith("shop-1");
    expect(test.database.conversationMessage.update).toHaveBeenNthCalledWith(1, {
      where: { id: "message-1" },
      data: { content: "Hello" },
    });
    expect(test.providerMock.sendWhatsAppText).toHaveBeenCalledWith({
      to: "+15551234567",
      text: "Hello",
      previewUrl: true,
      replyToProviderMessageId: "wamid-inbound",
    });
    expect(test.database.conversationMessage.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: "message-1" },
        data: expect.objectContaining({
          providerMessageId: "wamid-1",
          status: "SENT",
          sentAt: expect.any(Date),
        }),
      }),
    );
    expect(test.transaction.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: { lastMessageAt: expect.any(Date) },
    });
  });

  it("uses recovery execution scope immediately before provider delivery", async () => {
    const test = harness();

    await test.service.sendPreparedText({
      ...admission,
      executionScope: "recovery",
      to: "+15551234567",
      text: "Recovery reply",
    });

    expect(test.executionEligibility.evaluate).toHaveBeenCalledWith(
      "shop-1",
      undefined,
      "recovery",
    );
  });

  it("forces deterministic terminal text for prepared text", async () => {
    const test = harness();

    await test.service.sendPreparedText({
      ...admission,
      terminal: true,
      to: "+15551234567",
      text: "ordinary agent reply",
    });

    expect(test.providerMock.sendWhatsAppText).toHaveBeenCalledWith({
      to: "+15551234567",
      text: TERMINAL_MESSAGE,
    });
    expect(test.database.conversationMessage.update).toHaveBeenNthCalledWith(1, {
      where: { id: "message-1" },
      data: { content: TERMINAL_MESSAGE },
    });
  });

  it("uses text transport instead of template transport for a terminal admission", async () => {
    const test = harness();

    await test.service.sendPreparedTemplate(
      { ...admission, terminal: true },
      {
        to: "+15551234567",
        templateName: "recovery",
        languageCode: "en",
      },
    );

    expect(test.providerMock.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(test.providerMock.sendWhatsAppText).toHaveBeenCalledWith({
      to: "+15551234567",
      text: TERMINAL_MESSAGE,
    });
  });

  it("suppresses and releases a prepared intent when execution freezes", async () => {
    const executionEligibility = {
      evaluate: vi.fn().mockResolvedValue({
        allowed: false,
        shopId: "shop-1",
        reason: "SUBSCRIPTION_FROZEN",
      }),
    };
    const test = harness({ executionEligibility });

    await expect(
      test.service.sendPreparedText({
        ...admission,
        to: "+15551234567",
        text: "Hello",
      }),
    ).resolves.toEqual({ kind: "suppressed", reason: "subscription-frozen" });

    expect(test.providerMock.sendWhatsAppText).not.toHaveBeenCalled();
    expect(test.database.conversationMessage.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: { status: "FAILED" },
    });
    expect(test.database.usageEvent.deleteMany).toHaveBeenCalledWith({
      where: {
        sourceId: "message-1",
        metric: "OUTBOUND_AUTOMATED_MESSAGE",
      },
    });
  });

  it("suppresses a template when the contract disappears before provider delivery", async () => {
    const executionEligibility = {
      evaluate: vi.fn().mockResolvedValue({
        allowed: false,
        shopId: "shop-1",
        reason: "CONTRACT_REQUIRED",
      }),
    };
    const test = harness({ executionEligibility });

    await expect(
      test.service.sendPreparedTemplate(admission, {
        to: "+15551234567",
        templateName: "recovery",
        languageCode: "en",
      }),
    ).resolves.toEqual({ kind: "suppressed", reason: "contract-required" });

    expect(test.providerMock.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(test.providerMock.sendWhatsAppText).not.toHaveBeenCalled();
  });

  it.each(["configuration-missing", "provider-rejected"])(
    "cleans up definitive provider failure %s",
    async (code) => {
      const error = Object.assign(new Error("rejected"), {
        name: "WhatsAppServiceError",
        code,
      });
      const test = harness({
        provider: { sendWhatsAppText: vi.fn().mockRejectedValue(error) },
      });

      await expect(
        test.service.sendPreparedText({
          ...admission,
          to: "+15551234567",
          text: "Hello",
        }),
      ).rejects.toThrow("rejected");

      expect(test.database.conversationMessage.update).toHaveBeenCalledWith({
        where: { id: "message-1" },
        data: { status: "FAILED" },
      });
      expect(test.database.usageEvent.deleteMany).toHaveBeenCalledOnce();
    },
  );

  it.each([
    Object.assign(new Error("unknown"), {
      name: "WhatsAppServiceError",
      code: "invalid-provider-response",
    }),
    new Error("socket closed"),
  ])("preserves pending intent for ambiguous provider failure", async (error) => {
    const test = harness({
      provider: { sendWhatsAppText: vi.fn().mockRejectedValue(error) },
    });

    await expect(
      test.service.sendPreparedText({
        ...admission,
        to: "+15551234567",
        text: "Hello",
      }),
    ).rejects.toThrow();

    expect(test.database.usageEvent.deleteMany).not.toHaveBeenCalled();
    expect(test.database.conversationMessage.update).toHaveBeenCalledTimes(1);
    expect(test.database.conversationMessage.update).toHaveBeenCalledWith({
      where: { id: "message-1" },
      data: { content: "Hello" },
    });
  });
});
