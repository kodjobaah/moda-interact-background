import { describe, expect, it, vi } from "vitest";
import {
  ConversationTurnProcessor,
  MAX_SETTLE_WINDOW_MS,
  QUIET_WINDOW_MS,
} from "../../../src/services/conversation-turn-processor.service.js";

const first = new Date("2026-09-08T12:00:00.000Z");

function state(overrides: Partial<any> = {}) {
  return {
    inboundVersion: 3,
    lastProcessedVersion: 0,
    lastInboundAt: new Date(first.getTime() + QUIET_WINDOW_MS),
    pendingTurnStartedAt: first,
    processingInboundVersion: null,
    processingStartedAt: null,
    ...overrides,
  };
}

function harness(overrides: Partial<any> = {}) {
  const queue = { add: vi.fn().mockResolvedValue(undefined) };
  const conversation = {
    getTurnState: vi.fn().mockResolvedValue(state()),
    claimTurn: vi.fn().mockResolvedValue(true),
    completeTurn: vi.fn().mockResolvedValue(true),
    releaseTurn: vi.fn().mockResolvedValue(undefined),
    hasChanged: vi.fn().mockResolvedValue(false),
    applyDetectedLanguage: vi.fn().mockResolvedValue(true),
  };
  const admission = {
    reserve: vi.fn().mockResolvedValue({
      kind: "admitted",
      messageId: "message-1",
      conversationId: "conversation-1",
      terminal: false,
    }),
    sendPreparedText: vi.fn().mockResolvedValue({
      kind: "admitted",
      messageId: "message-1",
      conversationId: "conversation-1",
      terminal: false,
    }),
    failPrepared: vi.fn().mockResolvedValue(undefined),
  };
  const runAgent = vi.fn().mockResolvedValue({
    replyText: "reply",
    detectedLanguageTag: null,
    detectedLanguageConfidence: null,
  });
  const loaded = {
    shopId: "shop-1",
    to: "+447700900000",
    context: { conversation: { messages: [{ role: "user", content: "Hi" }] } },
    languageMessage: "Hi",
  };
  const now = overrides.now ?? (() => new Date(first.getTime() + 20_000));
  const processor = new ConversationTurnProcessor({
    queue,
    conversation,
    admission,
    loadTurn: vi.fn().mockResolvedValue(loaded),
    runAgent,
    getResult: (result: any) => result,
    now,
  });

  return {
    processor,
    queue,
    conversation,
    admission,
    runAgent,
    loaded,
    ...overrides,
  };
}

describe("ConversationTurnProcessor", () => {
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

  it("honors the ten-second maximum despite continuous fragments", async () => {
    const test = harness();
    test.conversation.getTurnState.mockResolvedValue(
      state({ lastInboundAt: new Date(first.getTime() + 9_999) }),
    );

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.runAgent).toHaveBeenCalledTimes(1);
    expect(test.queue.add).not.toHaveBeenCalled();
  });

  it("no-ops duplicate or stale observed versions", async () => {
    const test = harness();
    test.conversation.getTurnState.mockResolvedValue(
      state({ inboundVersion: 4, lastProcessedVersion: 3 }),
    );

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.runAgent).not.toHaveBeenCalled();
    expect(test.admission.reserve).not.toHaveBeenCalled();
  });

  it("does not process a newer version from a stale job", async () => {
    const test = harness();
    test.conversation.getTurnState.mockResolvedValue(
      state({ inboundVersion: 4 }),
    );

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.runAgent).not.toHaveBeenCalled();
  });

  it("lets only one racing worker claim and process a conversation", async () => {
    const test = harness();
    test.conversation.claimTurn
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await Promise.all([
      test.processor.process({
        conversationId: "conversation-1",
        observedVersion: 3,
      }),
      test.processor.process({
        conversationId: "conversation-1",
        observedVersion: 3,
      }),
    ]);

    expect(test.runAgent).toHaveBeenCalledTimes(1);
    expect(test.queue.add).toHaveBeenCalledTimes(1);
    expect(test.queue.add.mock.calls[0]?.[2].jobId).toBe(
      "conversation-turn__conversation-1__3",
    );
  });

  it("processes different conversations concurrently", async () => {
    const test = harness();
    let active = 0;
    let maximum = 0;
    test.runAgent.mockImplementation(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return {
        replyText: "reply",
        detectedLanguageTag: null,
        detectedLanguageConfidence: null,
      };
    });

    await Promise.all([
      test.processor.process({
        conversationId: "conversation-a",
        observedVersion: 3,
      }),
      test.processor.process({
        conversationId: "conversation-b",
        observedVersion: 3,
      }),
    ]);

    expect(maximum).toBe(2);
  });

  it("suppresses a stale agent response and schedules the newest version", async () => {
    const test = harness();
    test.conversation.hasChanged.mockResolvedValue(true);
    test.conversation.getTurnState
      .mockResolvedValueOnce(state())
      .mockResolvedValueOnce(state({ inboundVersion: 4 }));

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.admission.sendPreparedText).not.toHaveBeenCalled();
    expect(test.admission.failPrepared).toHaveBeenCalledWith("message-1");
    expect(test.queue.add).toHaveBeenCalledWith(
      "process-conversation-turn",
      { conversationId: "conversation-1", observedVersion: 4 },
      expect.objectContaining({
        jobId: "conversation-turn__conversation-1__4",
      }),
    );
  });

  it("does not call the agent when normal outbound capacity is exhausted", async () => {
    const test = harness();
    test.admission.reserve.mockResolvedValue({
      kind: "suppressed",
      reason: "terminal-already-used",
    });

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.runAgent).not.toHaveBeenCalled();
    expect(test.conversation.completeTurn).toHaveBeenCalledWith(
      "conversation-1",
      3,
    );
  });

  it("sends the deterministic terminal path without calling the agent", async () => {
    const test = harness();
    test.admission.reserve.mockResolvedValue({
      kind: "admitted",
      messageId: "terminal-1",
      conversationId: "conversation-1",
      terminal: true,
    });

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.runAgent).not.toHaveBeenCalled();
    expect(test.admission.sendPreparedText).toHaveBeenCalledTimes(1);
  });

  it("does not reserve an inbound billing metric", async () => {
    const test = harness();

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.admission.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ senderType: "AGENT" }),
    );
    expect(test.admission.reserve.mock.calls[0]?.[0]).not.toHaveProperty(
      "metric",
    );
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

  it("allows a stale processing lease to be reclaimed but a live lease to wait", async () => {
    const test = harness();
    test.conversation.claimTurn
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });
    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.runAgent).toHaveBeenCalledTimes(1);
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

  it("reuses one logical job ID for repeated early executions", async () => {
    const test = harness({
      now: () => new Date(first.getTime() + 1_000),
    });
    test.conversation.getTurnState.mockResolvedValue(
      state({ lastInboundAt: new Date(first.getTime() + 1_000) }),
    );

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });
    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.queue.add).toHaveBeenCalledTimes(2);
    expect(
      new Set(test.queue.add.mock.calls.map((call: any[]) => call[2].jobId)),
    ).toEqual(new Set(["conversation-turn__conversation-1__3"]));
  });

  it("moves an active job back to delayed with its lock token", async () => {
    const test = harness({
      now: () => new Date(first.getTime() + 1_000),
    });
    const activeJob = {
      id: "conversation-turn__conversation-1__3",
      token: "worker-lock-token",
      moveToDelayed: vi.fn().mockResolvedValue(undefined),
    };

    test.conversation.getTurnState.mockResolvedValue(
      state({ lastInboundAt: new Date(first.getTime() + 1_000) }),
    );

    await expect(
      test.processor.process(
        {
          conversationId: "conversation-1",
          observedVersion: 3,
        },
        activeJob,
      ),
    ).rejects.toMatchObject({ name: "DelayedError" });

    expect(activeJob.moveToDelayed).toHaveBeenCalledWith(
      expect.any(Number),
      "worker-lock-token",
    );
    expect(test.queue.add).not.toHaveBeenCalled();
    expect(test.runAgent).not.toHaveBeenCalled();
  });

  it("uses the exact BullMQ-safe conversation/version job id", async () => {
    const test = harness({
      now: () => new Date(first.getTime() + 1_000),
    });
    test.conversation.getTurnState.mockResolvedValue(
      state({ lastInboundAt: new Date(first.getTime() + 1_000) }),
    );

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    const jobId = test.queue.add.mock.calls[0]?.[2].jobId;
    expect(jobId).toBe("conversation-turn__conversation-1__3");
    expect(jobId).not.toContain(":");
  });

  it("leaves an ambiguous provider reservation durable and releases the lease", async () => {
    const test = harness();
    const ambiguous = new Error("provider outcome unknown");
    test.admission.sendPreparedText.mockRejectedValue(ambiguous);

    await expect(
      test.processor.process({
        conversationId: "conversation-1",
        observedVersion: 3,
      }),
    ).rejects.toThrow("provider outcome unknown");

    expect(test.admission.failPrepared).not.toHaveBeenCalled();
    expect(test.conversation.releaseTurn).toHaveBeenCalledWith(
      "conversation-1",
      3,
    );
  });

  it("leaves definitive provider cleanup to outbound admission and releases the lease", async () => {
    const test = harness();
    test.admission.sendPreparedText.mockRejectedValue(
      new Error("definitive provider rejection"),
    );

    await expect(
      test.processor.process({
        conversationId: "conversation-1",
        observedVersion: 3,
      }),
    ).rejects.toThrow("definitive provider rejection");

    expect(test.admission.failPrepared).not.toHaveBeenCalled();
    expect(test.conversation.releaseTurn).toHaveBeenCalledWith(
      "conversation-1",
      3,
    );
  });
});
