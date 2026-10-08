import { expect, it, vi } from "vitest";
import type { ConversationTurnFacadeContext } from "../conversation-turn-processor.service.test.js";

export function registerAbuseAdmissionCases(context: ConversationTurnFacadeContext) {
  const { harness, state, first, ConversationTurnProcessor } = context;

  it("B011-16 handles a settled abuse denial without outbound or agent work", async () => {
    const test = harness();
    test.loaded.customerPhone = "+447700900000";
    test.loaded.conversationType = "PRODUCT_SUPPORT";
    test.loaded.hasReplyContext = false;
    test.loaded.checkoutRecoveryId = "recovery-1";
    test.processor = new ConversationTurnProcessor({
      queue: test.queue,
      conversation: test.conversation,
      admission: test.admission,
      abuseAdmission: test.abuseAdmission,
      abuseAdmission: {
        admitSettledTurn: vi.fn().mockResolvedValue({
          kind: "denied",
          stage: "settled-turn",
          reason: "TURN_SENDER_SHORT",
        }),
      },
      loadTurn: vi.fn().mockResolvedValue(test.loaded),
      runAgent: test.runAgent,
      getResult: (result: any) => result,
      now: () => new Date(first.getTime() + 20_000),
      runtimeConfig: test.runtimeConfig,
    });

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.conversation.completeTurn).toHaveBeenCalledWith(
      "conversation-1",
      3,
    );
    expect(test.admission.reserve).not.toHaveBeenCalled();
    expect(test.runAgent).not.toHaveBeenCalled();
  });

  it("B011-18 handles limiter unavailability with the same suppression cleanup", async () => {
    const test = harness();
    test.abuseAdmission.admitSettledTurn.mockResolvedValue({
      kind: "denied",
      stage: "settled-turn",
      reason: "LIMITER_UNAVAILABLE",
    });

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.conversation.completeTurn).toHaveBeenCalledWith(
      "conversation-1",
      3,
    );
    expect(test.conversation.releaseTurn).not.toHaveBeenCalled();
    expect(test.admission.reserve).not.toHaveBeenCalled();
    expect(test.runAgent).not.toHaveBeenCalled();
  });

  it("B011-R1 releases only the obsolete lease and enqueues a newer version", async () => {
    const test = harness();
    test.abuseAdmission.admitSettledTurn.mockResolvedValue({
      kind: "denied",
      stage: "settled-turn",
      reason: "TURN_SENDER_SHORT",
    });
    test.conversation.completeTurn.mockResolvedValue(false);
    test.conversation.getTurnState
      .mockResolvedValueOnce(state())
      .mockResolvedValueOnce(state({ inboundVersion: 4 }))
      .mockResolvedValueOnce(state({ inboundVersion: 4 }));

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.conversation.releaseTurn).toHaveBeenCalledWith(
      "conversation-1",
      3,
    );
    expect(test.queue.add).toHaveBeenCalledWith(
      "process-conversation-turn",
      { conversationId: "conversation-1", observedVersion: 4 },
      expect.objectContaining({ jobId: "conversation-turn__conversation-1__4" }),
    );
    expect(test.admission.reserve).not.toHaveBeenCalled();
    expect(test.runAgent).not.toHaveBeenCalled();
  });

  it("B011-R2 applies the same newer-version race cleanup to limiter unavailability", async () => {
    const test = harness();
    test.abuseAdmission.admitSettledTurn.mockResolvedValue({
      kind: "denied",
      stage: "settled-turn",
      reason: "LIMITER_UNAVAILABLE",
    });
    test.conversation.completeTurn.mockResolvedValue(false);
    test.conversation.getTurnState
      .mockResolvedValueOnce(state())
      .mockResolvedValueOnce(state({ inboundVersion: 4 }))
      .mockResolvedValueOnce(state({ inboundVersion: 4 }));

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.conversation.releaseTurn).toHaveBeenCalledWith(
      "conversation-1",
      3,
    );
    expect(test.queue.add.mock.calls[0]?.[1]).toEqual({
      conversationId: "conversation-1",
      observedVersion: 4,
    });
  });

  it("passes RECOVERY directly to settled admission and uses standard processing", async () => {
    const test = harness();
    test.loaded.conversationType = "RECOVERY";

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.abuseAdmission.admitSettledTurn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationType: "RECOVERY" }),
    );
    expect(test.runAgent).toHaveBeenCalledTimes(1);
  });
}
