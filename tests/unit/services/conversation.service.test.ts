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
      findMany: vi.fn(),
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
      inboundVersion: 1,
      lastProcessedVersion: 1,
      pendingTurnStartedAt: null,
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
        pendingTurnStartedAt: expect.any(Date),
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
      select: {
        inboundVersion: true,
        lastProcessedVersion: true,
        pendingTurnStartedAt: true,
        languageTag: true,
        languageSource: true,
      },
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

describe("ConversationService standalone snapshots", () => {
  it("uses the explicit shop for a standalone conversation", async () => {
    prismaMock.conversation.findUniqueOrThrow.mockResolvedValue({
      id: "conversation-1",
      type: "PRODUCT_DISCOVERY",
      summary: null,
      inboundVersion: 1,
      languageTag: "en-GB",
      languageSource: "SHOPIFY",
      shop: { domain: "example.myshopify.com" },
      checkoutRecovery: null,
    });
    prismaMock.conversationMessage.findMany.mockResolvedValue([
      { direction: "INBOUND", content: "Need a black shirt" },
    ] as any);

    const snapshot = await new ConversationService().getAgentSnapshot("conversation-1");

    expect(snapshot).toMatchObject({
      conversationId: "conversation-1",
      shop: "example.myshopify.com",
      type: "PRODUCT_DISCOVERY",
      messages: [{ role: "user", content: "Need a black shirt" }],
    });
  });
});

describe("ConversationService turn state", () => {
  it("claims only the expected version and permits stale lease reclamation", async () => {
    prismaMock.conversation.updateMany.mockClear();
    const now = new Date("2026-09-08T12:00:00.000Z");
    prismaMock.conversation.findUniqueOrThrow.mockResolvedValue({
      inboundVersion: 3,
      lastProcessedVersion: 2,
      lastInboundAt: new Date("2026-09-08T11:59:59.000Z"),
      pendingTurnStartedAt: new Date("2026-09-08T11:59:50.000Z"),
      processingInboundVersion: null,
      processingStartedAt: null,
    });
    prismaMock.conversation.updateMany.mockResolvedValue({ count: 1 });

    const service = new ConversationService();

    await expect(service.getTurnState("conversation-1")).resolves.toMatchObject({
      inboundVersion: 3,
      lastProcessedVersion: 2,
    });
    await expect(service.claimTurn("conversation-1", 3, now)).resolves.toBe(true);

    expect(prismaMock.conversation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "conversation-1",
        inboundVersion: 3,
        lastProcessedVersion: { lt: 3 },
        pendingTurnStartedAt: { not: null },
        OR: [
          { processingInboundVersion: null },
          { processingStartedAt: { lt: new Date("2026-09-08T11:58:00.000Z") } },
        ],
      },
      data: {
        processingInboundVersion: 3,
        processingStartedAt: now,
      },
    });
  });

  it("clears pending and processing state only for the claimed version", async () => {
    prismaMock.conversation.updateMany.mockClear();
    prismaMock.conversation.updateMany.mockResolvedValue({ count: 1 });
    const service = new ConversationService();

    await expect(service.completeTurn("conversation-1", 4)).resolves.toBe(true);
    await service.releaseTurn("conversation-1", 5);

    expect(prismaMock.conversation.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: "conversation-1",
        inboundVersion: 4,
        processingInboundVersion: 4,
      },
      data: {
        lastProcessedVersion: 4,
        pendingTurnStartedAt: null,
        processingInboundVersion: null,
        processingStartedAt: null,
      },
    });
    expect(prismaMock.conversation.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "conversation-1", processingInboundVersion: 5 },
      data: { processingInboundVersion: null, processingStartedAt: null },
    });
  });
});