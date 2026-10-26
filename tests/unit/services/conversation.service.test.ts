import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ConversationLanguageService,
} from "../../../src/services/conversation-language.service.js";
import { ConversationService } from "../../../src/services/conversation.service.js";

const { prismaMock, txConversationUpdate, txConversationUpdateMany, operationReader } =
  vi.hoisted(() => ({
    operationReader: vi.fn(async () => ({ moderation: { value: { modelId: "omni-moderation-latest" } } })),
    txConversationUpdate: vi.fn(),
    txConversationUpdateMany: vi.fn(),
    prismaMock: {
      conversationMessage: {
        findUnique: vi.fn(),
        create: vi.fn(),
        findMany: vi.fn(),
      },
      checkoutRecovery: { findUniqueOrThrow: vi.fn() },
      conversationModerationAssessment: { findMany: vi.fn() },
      merchantConversationSendCommand: { findMany: vi.fn() },
      conversation: {
        upsert: vi.fn(),
        findUniqueOrThrow: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      $transaction: vi.fn(),
    },
  }));

vi.mock("../../../src/lib/db.js", () => ({ default: prismaMock }));
vi.mock("../../../src/services/conversation-moderation/moderation-operation.js", () => ({
  readModerationOperation: operationReader,
}));

describe("ConversationService language persistence", () => {
  it("starts the settle window at receipt time when a provider event is delayed", async () => {
    const receivedAt = new Date("2026-10-26T22:15:00.000Z");
    const occurredAt = new Date(receivedAt.getTime() - 60_000);
    vi.useFakeTimers();
    vi.setSystemTime(receivedAt);
    try {
      prismaMock.conversationMessage.findUnique.mockResolvedValue(null);
      prismaMock.conversation.findUniqueOrThrow.mockResolvedValue({
        inboundVersion: 0,
        lastProcessedVersion: 0,
        pendingTurnStartedAt: null,
        languageTag: null,
        languageSource: null,
      });
      const create = vi.fn();
      const executeRaw = vi.fn().mockResolvedValue(1);
      const update = vi.fn().mockResolvedValue({ id: "conversation-1", inboundVersion: 1 });
      const updateMany = vi.fn().mockResolvedValue({ count: 1 });
      prismaMock.$transaction.mockImplementation(async (callback) =>
        callback({
          conversationMessage: { create },
          conversation: { updateMany, update },
          $executeRaw: executeRaw,
        } as any),
      );

      await new ConversationService().receiveMessage({
        conversationId: "conversation-1",
        providerMessageId: "wamid.delayed",
        inReplyToProviderId: null,
        content: "delayed inbound",
        occurredAt,
      });

      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({ createdAt: receivedAt }),
      });
      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: "conversation-1",
          inboundVersion: 0,
          lastProcessedVersion: 0,
          pendingTurnStartedAt: null,
        },
        data: { pendingTurnStartedAt: receivedAt },
      });
      expect(executeRaw.mock.calls[0]).toEqual([
        expect.any(Array),
        receivedAt,
        receivedAt,
        "conversation-1",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists initial language during receipt and applies detection after the agent", async () => {
    prismaMock.conversationMessage.findUnique.mockResolvedValue(null);
    prismaMock.conversation.findUniqueOrThrow.mockResolvedValue({
      inboundVersion: 1,
      lastProcessedVersion: 1,
      pendingTurnStartedAt: null,
      languageTag: "en-GB",
      languageSource: "SHOPIFY",
    });
    txConversationUpdate.mockResolvedValue({
      id: "conversation-1",
      inboundVersion: 2,
    });
    prismaMock.$transaction.mockImplementation(async (callback) =>
      callback({
        conversationMessage: {
          create: vi.fn(),
        },
        conversation: {
          updateMany: txConversationUpdateMany.mockResolvedValue({ count: 1 }),
          update: txConversationUpdate,
        },
        $executeRaw: vi.fn().mockResolvedValue(1),
      }),
    );

    const serviceLogger = {
      debug: vi.fn(),
      info: vi.fn(),
    } as any;
    const service = new ConversationService(
      new ConversationLanguageService(),
      serviceLogger,
    );

    await service.receiveMessage({
      conversationId: "conversation-1",
      providerMessageId: "wamid.1",
      inReplyToProviderId: null,
      content: "Je veux modifier cette commande",
    });

    expect(txConversationUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "conversation-1",
        inboundVersion: 1,
        lastProcessedVersion: 1,
        pendingTurnStartedAt: null,
      },
      data: { pendingTurnStartedAt: expect.any(Date) },
    });
    expect(txConversationUpdate).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: {
        inboundVersion: { increment: 1 },
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
        checkoutRecoveryId: true,
      },
    });
    prismaMock.conversation.findUniqueOrThrow.mockResolvedValue({
      inboundVersion: 2,
      languageTag: "en-GB",
      languageSource: "SHOPIFY",
      checkoutRecoveryId: "recovery-1",
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
      where: { id: "conversation-1", inboundVersion: 2, processingInboundVersion: 2, processingStartedAt: { gt: expect.any(Date) } },
      data: { languageTag: "fr", languageSource: "DETECTED" },
    });
    expect(serviceLogger.info).toHaveBeenCalledWith(
      "whatsapp.language.changed",
      expect.objectContaining({
        conversationId: "conversation-1",
        observedVersion: 2,
        previousLanguageTag: "en-GB",
        languageTag: "fr",
        languageSource: "detected",
      }),
    );
  });

  it("logs a bounded rejection at exactly 80% without persisting the language", async () => {
    const serviceLogger = {
      debug: vi.fn(),
      info: vi.fn(),
    } as any;
    const service = new ConversationService(
      new ConversationLanguageService(),
      serviceLogger,
    );
    prismaMock.conversation.findUniqueOrThrow.mockResolvedValue({
      inboundVersion: 2,
      languageTag: "en-GB",
      languageSource: "SHOPIFY",
      checkoutRecoveryId: "recovery-1",
    });
    prismaMock.conversation.updateMany.mockClear();

    await expect(
      service.applyDetectedLanguage({
        conversationId: "conversation-1",
        version: 2,
        message: "Bonjour, pouvez-vous m'aider avec ma commande ?",
        detectedLanguageTag: "fr",
        detectedLanguageConfidence: 0.8,
      }),
    ).resolves.toBe(false);

    expect(prismaMock.conversation.updateMany).not.toHaveBeenCalled();
    expect(serviceLogger.debug).toHaveBeenCalledWith(
      "whatsapp.language.detection_rejected",
      expect.objectContaining({
        conversationId: "conversation-1",
        observedVersion: 2,
        currentLanguageTag: "en-GB",
        detectedLanguageTag: "fr",
        detectedLanguageConfidence: 0.8,
        reason: "low-confidence",
      }),
    );
    expect(serviceLogger.info).not.toHaveBeenCalled();
  });

  it("persists a provider duplicate only once", async () => {
    prismaMock.conversationMessage.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        conversationId: "conversation-1",
        conversation: {
          inboundVersion: 1,
          languageTag: null,
          languageSource: null,
        },
      } as any);
    prismaMock.conversation.findUniqueOrThrow.mockResolvedValue({
      inboundVersion: 1,
      lastProcessedVersion: 1,
      pendingTurnStartedAt: null,
      languageTag: null,
      languageSource: null,
    });
    const create = vi.fn();
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const update = vi.fn().mockResolvedValue({
      id: "conversation-1",
      inboundVersion: 2,
    });
    prismaMock.$transaction.mockImplementation(async (callback) =>
      callback({
        conversationMessage: { create },
        conversation: { updateMany, update },
        $executeRaw: vi.fn().mockResolvedValue(1),
      } as any),
    );

    const service = new ConversationService();
    const message = {
      conversationId: "conversation-1",
      providerMessageId: "wamid.duplicate",
      inReplyToProviderId: null,
      content: "hello",
    };

    await expect(service.receiveMessage(message)).resolves.toMatchObject({
      duplicate: false,
      version: 2,
    });
    await expect(service.receiveMessage(message)).resolves.toEqual({
      conversationId: "conversation-1",
      version: 1,
      duplicate: true,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("ConversationService standalone snapshots", () => {
  function setupStandaloneHistory() {
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
      { id: "customer-1", direction: "INBOUND", senderType: "CUSTOMER", content: "Need a black shirt" },
      { id: "customer-2", direction: "INBOUND", senderType: "CUSTOMER", content: "moderation-fixture-block" },
    ]);
    prismaMock.conversationModerationAssessment.findMany.mockResolvedValue([{
      conversationMessageId: "customer-1",
      contentSha256: createHash("sha256").update("Need a black shirt", "utf8").digest("hex"),
    }]);
    prismaMock.merchantConversationSendCommand.findMany.mockResolvedValue([]);
    operationReader.mockResolvedValue({ moderation: { value: { modelId: "omni-moderation-latest" } } });
  }

  it("uses the explicit shop but includes only an exact moderation ALLOW", async () => {
    setupStandaloneHistory();
    const snapshot = await new ConversationService().getAgentSnapshot("conversation-1");
    expect(snapshot).toMatchObject({
      conversationId: "conversation-1",
      shop: "example.myshopify.com",
      type: "PRODUCT_DISCOVERY",
      summary: null,
      messages: [{ role: "user", content: "Need a black shirt" }],
    });
    expect(prismaMock.conversationModerationAssessment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({
        decision: "ALLOW", requestedModel: "omni-moderation-latest",
      }) }),
    );
  });

  it("fails closed when moderation configuration cannot be read", async () => {
    setupStandaloneHistory();
    operationReader.mockRejectedValueOnce(new Error("DB_UNAVAILABLE"));
    await expect(new ConversationService().getAgentSnapshot("conversation-1"))
      .rejects.toThrow("DB_UNAVAILABLE");
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

    await expect(service.getTurnState("conversation-1")).resolves.toMatchObject(
      {
        inboundVersion: 3,
        lastProcessedVersion: 2,
      },
    );
    await expect(service.claimTurn("conversation-1", 3, now)).resolves.toBe(
      true,
    );

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

  it("keeps the first pending-turn timestamp when concurrent receipts race", async () => {
    const conditionalUpdate = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    let nextVersion = 2;
    prismaMock.conversationMessage.findUnique.mockResolvedValue(null);
    prismaMock.conversation.findUniqueOrThrow.mockResolvedValue({
      inboundVersion: 1,
      lastProcessedVersion: 1,
      pendingTurnStartedAt: null,
      languageTag: null,
      languageSource: null,
    });
    prismaMock.$transaction.mockImplementation(async (callback) =>
      callback({
        conversationMessage: { create: vi.fn() },
        conversation: {
          updateMany: conditionalUpdate,
          update: vi.fn().mockImplementation(async () => ({
            id: "conversation-1",
            inboundVersion: nextVersion++,
          })),
        },
        $executeRaw: vi.fn().mockResolvedValue(1),
      }),
    );

    const service = new ConversationService();
    await Promise.all([
      service.receiveMessage({
        conversationId: "conversation-1",
        providerMessageId: "wamid.concurrent-1",
        inReplyToProviderId: null,
        content: "first",
      }),
      service.receiveMessage({
        conversationId: "conversation-1",
        providerMessageId: "wamid.concurrent-2",
        inReplyToProviderId: null,
        content: "second",
      }),
    ]);

    expect(conditionalUpdate).toHaveBeenCalledTimes(2);
    expect(conditionalUpdate).toHaveBeenNthCalledWith(1, {
      where: {
        id: "conversation-1",
        inboundVersion: 1,
        lastProcessedVersion: 1,
        pendingTurnStartedAt: null,
      },
      data: { pendingTurnStartedAt: expect.any(Date) },
    });
    expect(conditionalUpdate).toHaveBeenNthCalledWith(2, {
      where: {
        id: "conversation-1",
        inboundVersion: 1,
        lastProcessedVersion: 1,
        pendingTurnStartedAt: null,
      },
      data: { pendingTurnStartedAt: expect.any(Date) },
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

describe("A1 shop language recovery initialization", () => {
 it.each(["en-GB", "fr"])("initializes %s from shared Shop context without ShopSettings", async (languageTag) => {
  prismaMock.checkoutRecovery.findUniqueOrThrow.mockResolvedValue({shop:{id:"shop-1",defaultLanguageTag:languageTag}});
  prismaMock.conversation.upsert.mockClear();
  await new ConversationService().getOrCreateRecoveryConversation("recovery-1",{languageTag:"fr-FR",languageSource:"shopify",countryCode:"FR",currencyCode:"GBP",timeZone:"Europe/London"});
  expect(prismaMock.checkoutRecovery.findUniqueOrThrow).toHaveBeenCalledWith({where:{id:"recovery-1"},select:{shop:{select:{id:true,defaultLanguageTag:true}}}});
  expect(prismaMock.conversation.upsert).toHaveBeenCalledWith({where:{checkoutRecoveryId:"recovery-1"},create:{shopId:"shop-1",checkoutRecoveryId:"recovery-1",type:"RECOVERY",languageTag,languageSource:"MERCHANT_DEFAULT",countryCode:"FR",currencyCode:"GBP",timeZone:"Europe/London"},update:{}});
 });
 it.each([null,"invalid_@@"])("L02 missing/invalid shop has no invented locale (%s)", async(defaultLanguageTag)=>{
  prismaMock.checkoutRecovery.findUniqueOrThrow.mockResolvedValue({shop:{id:"shop-1",defaultLanguageTag}});
  await new ConversationService().getOrCreateRecoveryConversation("recovery-1");
  expect(prismaMock.conversation.upsert).toHaveBeenLastCalledWith(expect.objectContaining({create:expect.objectContaining({languageTag:null,languageSource:null}),update:{}}));
 });
 it("L03 preserves established French on the next initial-resolution pass",async()=>{
  expect(new ConversationLanguageService().resolveInitialLanguage({currentLanguageTag:"fr",currentLanguageSource:"detected",merchantLanguageTag:"en-GB"})).toMatchObject({languageTag:"fr",languageSource:"detected",changed:false});
 });
});
