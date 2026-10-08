import { expect, it } from "vitest";
import type { ConversationTurnFacadeContext } from "../conversation-turn-processor.service.test.js";

export function registerContextCases(context: ConversationTurnFacadeContext) {
  const { harness, state, first } = context;

  it("settles three fragments into one agent turn and one response", async () => {
    const test = harness();
    test.loaded.context.conversation.messages = [
      { role: "user", content: "Hi I was looking at" },
      { role: "user", content: "the black jacket" },
      { role: "user", content: "sorry I mean blue" },
    ];
    test.loaded.languageMessage =
      "Hi I was looking at\nthe black jacket\nsorry I mean blue";

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.runAgent).toHaveBeenCalledTimes(1);
    expect(test.admission.reserve).toHaveBeenCalledTimes(1);
    expect(test.admission.sendPreparedText).toHaveBeenCalledTimes(1);
    expect(test.conversation.applyDetectedLanguage).toHaveBeenCalledWith(
      expect.objectContaining({ message: test.loaded.languageMessage }),
    );
  });

  it("processes messages more than three seconds apart as separate turns", async () => {
    const test = harness();
    const states = [
      state({ inboundVersion: 1, lastProcessedVersion: 0 }),
      state({ inboundVersion: 2, lastProcessedVersion: 1 }),
    ];
    test.conversation.getTurnState.mockImplementation(
      async () => states.shift() ?? state(),
    );

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 1,
    });
    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 2,
    });

    expect(test.runAgent).toHaveBeenCalledTimes(2);
  });

  it("coalesces product-only standalone fragments through one agent call", async () => {
    const test = harness();
    test.loaded.context.conversation.type = "PRODUCT_DISCOVERY";

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.runAgent).toHaveBeenCalledTimes(1);
    expect(test.admission.sendPreparedText).toHaveBeenCalledTimes(1);
  });

  it("coalesces recovery fragments through one agent call", async () => {
    const test = harness();
    test.loaded.context.recovery = { id: "recovery-1" };

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.runAgent).toHaveBeenCalledTimes(1);
  });

  it("processes a resolved clarification context with its standalone fragments", async () => {
    const test = harness();
    test.loaded.context = {
      shop: "resolved-shop.myshopify.com",
      recovery: {
        id: "recovery-current",
        status: "ENGAGED",
        checkoutToken: "checkout-current",
        completedAt: null,
        totalPrice: "42.00",
      },
      customer: {
        id: "customer-current",
        phone: "+447700900000",
        firstName: "Ada",
      },
      conversation: {
        conversationId: "clarification-1",
        shop: "resolved-shop.myshopify.com",
        type: "PRODUCT_SUPPORT",
        summary: null,
        version: 3,
        languageTag: "en-GB",
        languageSource: "shopify",
        messages: [
          { role: "user", content: "Which basket?" },
          { role: "user", content: "The blue one" },
        ],
      },
    };
    test.loaded.languageMessage = "Which basket?\nThe blue one";

    await test.processor.process({
      conversationId: "clarification-1",
      observedVersion: 3,
    });

    expect(test.admission.reserve).toHaveBeenCalledBefore(test.runAgent);
    expect(test.runAgent).toHaveBeenCalledTimes(1);
    expect(test.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        recovery: expect.objectContaining({ id: "recovery-current" }),
        conversation: expect.objectContaining({
          conversationId: "clarification-1",
          messages: [
            { role: "user", content: "Which basket?" },
            { role: "user", content: "The blue one" },
          ],
        }),
      }),
    );
    expect(test.admission.sendPreparedText).toHaveBeenCalledTimes(1);
  });

  it("sends one current same-owner clarification without CommerceAgent", async () => {
    const test = harness();
    test.loaded.context = null;
    test.loaded.clarificationText =
      "I found more than one recent basket.\n- checkout-1\n- checkout-2";

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.runAgent).not.toHaveBeenCalled();
    expect(test.admission.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        senderType: "AUTOMATION",
        content: expect.stringContaining("checkout-1"),
      }),
    );
    expect(test.admission.sendPreparedText).toHaveBeenCalledTimes(1);
  });

  it("uses deterministic ordering already assembled by the conversation snapshot", async () => {
    const test = harness();
    test.loaded.context.conversation.messages = [
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ];
    test.loaded.languageMessage = "first\nsecond";

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.conversation.applyDetectedLanguage).toHaveBeenCalledWith(
      expect.objectContaining({ message: "first\nsecond" }),
    );
  });
}
