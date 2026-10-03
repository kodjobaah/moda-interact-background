import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecoveryAgentContextService } from "../../../../src/services/checkout-recovery/recovery-agent-context.service.js";

const startedAt = new Date("2026-10-03T10:00:00.000Z");
const recovery = {
  id: "recovery-1",
  shopId: "canonical-shop-id",
  shop: { domain: "canonical-shop.myshopify.com" },
  status: "ENGAGED",
  checkoutToken: "checkout-1",
  completedAt: null,
  totalPrice: { toString: () => "42.00" },
  customer: { id: "customer-1", phone: "+447700900000", firstName: "Ada" },
};
const conversation = {
  id: "conversation-1",
  type: "RECOVERY",
  summary: "A bounded summary",
  inboundVersion: 7,
  languageTag: "fr-CA",
  languageSource: "SHOPIFY_IMPORT",
};
const priorHistory = [{ role: "assistant" as const, content: "Earlier reply" }];
const currentMessages = [
  { role: "user" as const, content: "first equal-time message" },
  { role: "user" as const, content: "second equal-time message" },
];

function createHarness({
  durableRecovery = { ...recovery, conversation },
  standaloneRecovery = recovery,
  snapshot = {
    conversationId: "conversation-1",
    shop: "conversation-owned-shop.myshopify.com",
    type: "PRODUCT_SUPPORT",
    summary: "Standalone summary",
    version: 3,
    languageTag: "en-GB",
    languageSource: "shopify" as const,
    messages: [{ role: "user" as const, content: "Standalone fragment" }],
  },
} = {}) {
  const recoveryRows = [durableRecovery, standaloneRecovery];
  const database = {
    checkoutRecovery: {
      findUnique: vi.fn(async () => recoveryRows.shift() ?? null),
    },
  };
  const conversationService = {
    getAgentSnapshot: vi.fn(async () => snapshot),
  };
  const historyLoader = vi.fn(async () => ({
    history: priorHistory,
    currentMessages,
    oversized: true,
  }));
  const service = new RecoveryAgentContextService(
    database as never,
    conversationService as never,
    historyLoader as never,
  );

  return { database, conversationService, historyLoader, service };
}

describe("RecoveryAgentContextService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves bounded equal-timestamp current order and separates prior history", async () => {
    const harness = createHarness();

    const context = await harness.service.getAgentContext({
      checkoutRecoveryId: "recovery-1",
      conversationId: "conversation-1",
      pendingTurnStartedAt: startedAt,
    });

    expect(context).toEqual({
      shopId: "canonical-shop-id",
      shop: "canonical-shop.myshopify.com",
      recovery: {
        id: "recovery-1",
        status: "ENGAGED",
        checkoutToken: "checkout-1",
        completedAt: null,
        totalPrice: "42.00",
      },
      customer: { id: "customer-1", phone: "+447700900000", firstName: "Ada" },
      conversation: {
        conversationId: "conversation-1",
        shop: "canonical-shop.myshopify.com",
        type: "RECOVERY",
        summary: "A bounded summary",
        version: 7,
        languageTag: "fr-CA",
        languageSource: "shopify-import",
        messages: currentMessages,
        history: priorHistory,
        oversized: true,
      },
    });
    expect(harness.historyLoader).toHaveBeenCalledWith("conversation-1", startedAt);
    expect(harness.database.checkoutRecovery.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "recovery-1" },
        select: expect.objectContaining({
          conversation: expect.objectContaining({
            where: { id: "conversation-1" },
            take: 1,
          }),
        }),
      }),
    );
  });

  it("uses the current time boundary when no pending-turn timestamp is supplied", async () => {
    const harness = createHarness();
    const before = Date.now();

    await harness.service.getAgentContext({
      checkoutRecoveryId: "recovery-1",
      conversationId: "conversation-1",
    });

    const [, boundary] = harness.historyLoader.mock.calls[0];
    expect(boundary).toBeInstanceOf(Date);
    expect(boundary.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("throws when the recovery does not exist", async () => {
    const harness = createHarness({ durableRecovery: null });

    await expect(harness.service.getAgentContext({
      checkoutRecoveryId: "missing-recovery",
      conversationId: "conversation-1",
    })).rejects.toThrow("Checkout recovery not found: missing-recovery");
    expect(harness.historyLoader).not.toHaveBeenCalled();
  });

  it("rejects a conversation that is not related to the requested recovery", async () => {
    const harness = createHarness({
      durableRecovery: { ...recovery, conversation: null },
    });

    await expect(harness.service.getAgentContext({
      checkoutRecoveryId: "recovery-1",
      conversationId: "foreign-conversation",
    })).rejects.toThrow(
      "Conversation foreign-conversation does not belong to recovery recovery-1",
    );
    expect(harness.historyLoader).not.toHaveBeenCalled();
  });

  it("uses the standalone snapshot owner and overlays canonical recovery shop without adding a conversation ownership query", async () => {
    const harness = createHarness();

    const context = await harness.service.getAgentContextForStandaloneConversation({
      checkoutRecoveryId: "recovery-1",
      conversationId: "standalone-conversation",
      pendingTurnStartedAt: startedAt,
    });

    expect(harness.conversationService.getAgentSnapshot).toHaveBeenCalledWith(
      "standalone-conversation",
      startedAt,
    );
    expect(harness.historyLoader).not.toHaveBeenCalled();
    expect(harness.database.checkoutRecovery.findUnique).toHaveBeenCalledOnce();
    expect(harness.database.checkoutRecovery.findUnique.mock.calls[0][0].select)
      .not.toHaveProperty("conversation");
    expect(context.shopId).toBe("canonical-shop-id");
    expect(context.shop).toBe("canonical-shop.myshopify.com");
    expect(context.conversation.shop).toBe("canonical-shop.myshopify.com");
    expect(context.conversation.messages).toEqual([
      { role: "user", content: "Standalone fragment" },
    ]);
  });

  it("propagates a missing standalone snapshot error unchanged", async () => {
    const harness = createHarness();
    harness.conversationService.getAgentSnapshot.mockRejectedValueOnce(
      new Error("Conversation has no shop ownership"),
    );

    await expect(harness.service.getAgentContextForStandaloneConversation({
      checkoutRecoveryId: "recovery-1",
      conversationId: "standalone-conversation",
    })).rejects.toThrow("Conversation has no shop ownership");
  });
});