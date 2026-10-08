import { expect, it } from "vitest";
import type { ConversationTurnFacadeContext } from "../conversation-turn-processor.service.test.js";

export function registerClaimAndStateCases(context: ConversationTurnFacadeContext) {
  const { harness, state, PROCESSING_LEASE_MS } = context;

  it("keeps the processing lease system-managed", () => {
    expect(PROCESSING_LEASE_MS).toBe(120_000);
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

  it("terminally completes a turn when its shop is inactive", async () => {
    const test = harness();
    test.loaded.shopUnavailable = true;

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.conversation.completeTurn).toHaveBeenCalledWith(
      "conversation-1",
      3,
    );
    expect(test.abuseAdmission.admitSettledTurn).not.toHaveBeenCalled();
    expect(test.admission.reserve).not.toHaveBeenCalled();
    expect(test.runAgent).not.toHaveBeenCalled();
  });

  it("does not re-enqueue a newer version when inactive completion loses a race", async () => {
    const test = harness();
    test.loaded.shopUnavailable = true;
    test.conversation.completeTurn.mockResolvedValue(false);
    test.conversation.getTurnState
      .mockResolvedValueOnce(state())
      .mockResolvedValueOnce(state({ inboundVersion: 4 }));

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.conversation.releaseTurn).toHaveBeenCalledWith(
      "conversation-1",
      3,
    );
    expect(test.queue.add).not.toHaveBeenCalled();
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
}
