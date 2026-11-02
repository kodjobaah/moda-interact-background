import { expect, it, vi } from "vitest";
import type { ConversationTurnFacadeContext } from "../conversation-turn-processor.service.test.js";

export function registerAgentRaceCases(context: ConversationTurnFacadeContext) {
  const { harness, state, first, ConversationTurnProcessor } = context;

  it("suppresses a stale agent response and schedules the newest version", async () => {
    const test = harness();
    test.conversation.hasChanged
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
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

  it("passes the original inbound version through a late ownership check", async () => {
    const test = harness();
    test.conversation.getTurnState.mockResolvedValue(state({
      pendingAiControlRevision: 7,
      controlRevision: 7,
    }));
    const ownership = {
      readTurnOwnership: async () => ({
        conversationId: "conversation-1", recoveryId: "recovery-1",
        shopId: "shop-1", mode: "AI" as const, revision: 7,
      }),
      checkAutomatedTurn: vi.fn(async ({ phase }: { phase: string }) => {
        if (phase === "before-provider") {
          test.conversation.getTurnState.mockResolvedValue(state({ inboundVersion: 4 }));
        }
        return { kind: "allowed" as const, phase };
      }),
    };
    const processor = new ConversationTurnProcessor({
      queue: test.queue,
      conversation: test.conversation,
      admission: test.admission,
      abuseAdmission: test.abuseAdmission,
      ownership,
      loadTurn: async () => test.loaded,
      runAgent: test.runAgent,
      aiWrapper: test.aiWrapper,
      getResult: (result: any) => result,
      now: () => new Date(first.getTime() + 20_000),
      runtimeConfig: test.runtimeConfig,
      logger: test.logger,
    });

    await processor.process({ conversationId: "conversation-1", observedVersion: 3 });

    expect(test.admission.sendPreparedText).toHaveBeenCalledWith(expect.objectContaining({
      expectedControlRevision: 7,
      expectedInboundVersion: 3,
    }));
  });

  it.each([
    ["AbortError", Object.assign(new Error("cancelled"), { name: "AbortError" })],
    ["ordinary cancellation", new Error("operator cancellation")],
    ["new inbound", new Error("STALE_TURN")],
    ["lease loss", new Error("STALE_TURN")],
  ])("suppresses %s after refresh without send or language mutation", async (_name, failure) => {
    const test = harness();
    test.runAgent.mockRejectedValue(failure);

    await expect(
      test.processor.process({
        conversationId: "conversation-1",
        observedVersion: 3,
      }),
    ).rejects.toThrow(failure.message);

    expect(test.admission.reserve).toHaveBeenCalledTimes(1);
    expect(test.admission.sendPreparedText).not.toHaveBeenCalled();
    expect(test.admission.failPrepared).toHaveBeenCalledWith("message-1");
    expect(test.conversation.applyDetectedLanguage).not.toHaveBeenCalled();
    expect(test.conversation.releaseTurn).toHaveBeenCalledWith(
      "conversation-1",
      3,
    );
  });
}
