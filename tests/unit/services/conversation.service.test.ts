import { describe, expect, it, vi } from "vitest";
import {
  ConversationLanguageService,
  type LanguageDetector,
} from "../../../src/services/conversation-language.service.js";
import { ConversationService } from "../../../src/services/conversation.service.js";

const { prismaMock, txConversationUpdate } = vi.hoisted(() => ({
  txConversationUpdate: vi.fn(),
  prismaMock: {
    conversationMessage: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    conversation: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("../../../src/lib/db.js", () => ({ default: prismaMock }));

describe("ConversationService language persistence", () => {
  it("persists initial language during receipt and applies detection after the agent", async () => {
    prismaMock.conversationMessage.findUnique.mockResolvedValue(null);
    prismaMock.conversation.findUniqueOrThrow.mockResolvedValue({
      languageTag: "en-GB",
      languageSource: "SHOPIFY",
    });
    txConversationUpdate.mockResolvedValue({ id: "conversation-1", inboundVersion: 2 });
    prismaMock.$transaction.mockImplementation(async (callback) =>
      callback({
        conversationMessage: {
          create: vi.fn(),
        },
        conversation: {
          update: txConversationUpdate,
        },
      }),
    );

    const detector: LanguageDetector = {
      detect: vi.fn().mockResolvedValue({ languageTag: "fr-FR", confidence: 0.96 }),
    };
    const service = new ConversationService(new ConversationLanguageService(detector));

    await service.receiveMessage({
      conversationId: "conversation-1",
      providerMessageId: "wamid.1",
      inReplyToProviderId: null,
      content: "Je veux modifier cette commande",
    });

    expect(txConversationUpdate).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: {
        inboundVersion: { increment: 1 },
        lastInboundAt: expect.any(Date),
        lastMessageAt: expect.any(Date),
        languageTag: "en-GB",
        languageSource: "SHOPIFY",
      },
      select: { id: true, inboundVersion: true },
    });
    expect(prismaMock.conversation.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      select: { languageTag: true, languageSource: true },
    });
    expect(detector.detect).not.toHaveBeenCalled();

    prismaMock.conversation.findUniqueOrThrow.mockResolvedValue({
      inboundVersion: 2,
      languageTag: "en-GB",
      languageSource: "SHOPIFY",
    });
    prismaMock.conversation.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.applyDetectedLanguage({
        conversationId: "conversation-1",
        version: 2,
        message: "Je veux modifier cette commande",
        detectedLanguageTag: "fr",
        detectedLanguageConfidence: 0.96,
      }),
    ).resolves.toBe(true);
    expect(prismaMock.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: "conversation-1", inboundVersion: 2 },
      data: { languageTag: "fr", languageSource: "DETECTED" },
    });
  });
});