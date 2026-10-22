import { describe, expect, it, vi } from "vitest";

import {
  OutboundMessageDeliveryService,
  TERMINAL_MESSAGE,
} from "../../../../src/services/outbound-whatsapp-admission/outbound-message-delivery.service.js";
import { prepareAutomatedTemplateInput } from "../../../../src/services/conversation-moderation/automated-template-input.js";

function harness({
  provider = {},
  executionEligibility = {
    evaluate: vi.fn(async () => ({ allowed: true as const, shopId: "shop-1" })),
  },
  moderationOutcome = "allow",
  currentAllowance = true,
}: {
  provider?: Record<string, unknown>;
  executionEligibility?: { evaluate: ReturnType<typeof vi.fn> };
  moderationOutcome?: "allow" | "block" | "retry";
  currentAllowance?: boolean;
} = {}) {
  let currentText = "Hello";
  const conversationMessageUpdate = vi.fn().mockImplementation(async ({ data }: { data: { content?: string } }) => {
    if (typeof data.content === "string") currentText = data.content;
    return {};
  });
  const conversationMessageFindUnique = vi.fn().mockImplementation(async () => ({
    conversationId: "conversation-1", senderType: "AGENT", content: currentText,
  }));
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
    $queryRawUnsafe: vi.fn(async () => []),
    $transaction: vi.fn().mockImplementation(async (operation: unknown) =>
      typeof operation === "function" ? operation(transaction) : undefined,
    ),
    conversationMessage: { update: conversationMessageUpdate, findUnique: conversationMessageFindUnique },
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

  const moderationMock = {
    assessText: vi.fn(async () => ({ kind: moderationOutcome })),
    requireCurrentAllowance: vi.fn(async () => currentAllowance),
  };
  return {
    database,
    transaction,
    providerMock,
    executionEligibility, moderationMock,
    service: new OutboundMessageDeliveryService(
      database as never,
      providerMock as never,
      executionEligibility as never,
      undefined,
      undefined,
      moderationMock as never,
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
  it("blocks prepared AI/automation messages when the recipient has locally stopped", async () => {
    const test = harness();
    test.database.$queryRawUnsafe.mockResolvedValue([{
      phone: "+447400123456", whatsappCanonicalPhone: "447400123456",
      defaultCountryCode: "GB",
    }]);
    await expect(test.service.sendPreparedText({
      ...admission, to: "+447400123456", text: "Don't send this",
    })).resolves.toEqual({ kind: "suppressed", reason: "conversation-invalid" });
    expect(test.providerMock.sendWhatsAppText).not.toHaveBeenCalled();
    expect(test.database.conversationMessage.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "message-1" }, data: { status: "FAILED" },
    }));
  });

  it("delegates provider account identity", async () => {
    const test = harness();

    await expect(test.service.getProviderAccountId()).resolves.toBe("phone-number-id");
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

  it("moderates a prepared AUTOMATION template's exact persisted parameters before Meta", async () => {
    const test = harness();
    const input = { to: "+15551234567", templateName: "recovery", languageCode: "en",
      bodyParameters: ["Cart details", "Customer supplied offer"], dynamicUrlButton: { index: 0, text: "cart-7" } };
    const effectiveText = prepareAutomatedTemplateInput(input).effectiveText;
    await expect(test.service.sendPreparedTemplate(admission, input))
      .resolves.toMatchObject({ kind: "admitted" });
    expect(test.database.conversationMessage.update).toHaveBeenNthCalledWith(1, {
      where: { id: "message-1" }, data: { content: effectiveText },
    });
    expect(test.moderationMock.assessText).toHaveBeenCalledWith(expect.objectContaining({
      subject: { kind: "AGENT_MESSAGE", messageId: "message-1" },
      effectiveText, inputKind: "TEXT", shopId: "shop-1", conversationId: "conversation-1",
    }));
    expect(test.moderationMock.requireCurrentAllowance).toHaveBeenCalledWith(expect.objectContaining({
      effectiveText, subject: { kind: "AGENT_MESSAGE", messageId: "message-1" },
    }));
    expect(test.providerMock.sendWhatsAppTemplate).toHaveBeenCalledOnce();
    expect(test.providerMock.sendWhatsAppTemplate).toHaveBeenCalledWith(input);
    expect(test.database.conversationMessage.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SENT" }),
    }));
  });

  it("suppresses a blocked automated template and releases its reserved usage", async () => {
    const test = harness({ moderationOutcome: "block" });
    const result = await test.service.sendPreparedTemplate(admission, {
      to: "+15551234567", templateName: "recovery", languageCode: "en", bodyParameters: ["flagged"] });
    expect(result).toMatchObject({ kind: "suppressed" });
    expect(test.providerMock.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(test.providerMock.sendWhatsAppText).not.toHaveBeenCalled();
    expect(test.database.usageEvent.deleteMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sourceId: "message-1" }),
    }));
  });

  it("does not reuse stale ALLOW when the template parameters are changed", async () => {
    const test = harness({ currentAllowance: false });
    const result = await test.service.sendPreparedTemplate(admission, {
      to: "+15551234567", templateName: "recovery", languageCode: "en", bodyParameters: ["changed after approval"] });
    expect(result).toMatchObject({ kind: "suppressed" });
    expect(test.moderationMock.assessText).toHaveBeenCalledOnce();
    expect(test.moderationMock.requireCurrentAllowance).toHaveBeenCalledOnce();
    expect(test.providerMock.sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("rejects an unmoderated image-header template without Meta admission", async () => {
    const test = harness();
    const result = await test.service.sendPreparedTemplate(admission, {
      to: "+15551234567", templateName: "recovery", languageCode: "en",
      imageHeader: { link: "https://example.test/image" },
    });
    expect(result).toMatchObject({ kind: "suppressed" });
    expect(test.moderationMock.assessText).not.toHaveBeenCalled();
    expect(test.providerMock.sendWhatsAppTemplate).not.toHaveBeenCalled();
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

  it("converges synchronous 131026 through compensation and reachability owners", async () => {
    const error = Object.assign(new Error("rejected"), {
      name: "WhatsAppServiceError", code: "provider-rejected", providerCode: "131026",
    });
    const failureAdapter = { afterProviderError: vi.fn(async () => undefined),
      failPrepared: vi.fn(async () => undefined) };
    const test = harness({ provider: { sendWhatsAppText: vi.fn().mockRejectedValue(error) } });
    const service = new OutboundMessageDeliveryService(
      test.database as never, test.providerMock as never, test.executionEligibility as never,
      undefined, undefined, test.moderationMock as never, failureAdapter as never,
    );

    await expect(service.sendPreparedText({ ...admission, to: "+15551234567", text: "Hello" }))
      .rejects.toBe(error);
    expect(failureAdapter.afterProviderError).toHaveBeenCalledWith(
      "message-1", "+15551234567", error,
    );
  });
});
