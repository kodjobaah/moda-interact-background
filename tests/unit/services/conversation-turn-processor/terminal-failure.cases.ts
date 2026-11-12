import { expect, it } from "vitest";
import { CommerceHostError } from "../../../../src/commerce/mcp-client.js";
import type { ConversationTurnFacadeContext } from "../conversation-turn-processor.service.test.js";

export function registerTerminalFailureCases(context: ConversationTurnFacadeContext) {
  const { harness, state } = context;

  it.each(["INVALID_FINAL", "INVALID_INPUT"] as const)("consumes typed nonretryable %s after reservation cleanup without sending", async code => {
    const test = harness();
    const failure = new CommerceHostError(code, false);
    test.runAgent.mockRejectedValue(failure);
    test.conversation.getTurnState.mockResolvedValue(state({ pendingAiControlRevision: 7 }));

    await expect(test.processor.process({ conversationId: "conversation-1", observedVersion: 3 })).resolves.toBeUndefined();

    expect(test.admission.failPrepared).toHaveBeenCalledExactlyOnceWith("message-1");
    expect(test.conversation.completeTurn).toHaveBeenCalledExactlyOnceWith("conversation-1", 3, 7);
    expect(test.admission.failPrepared.mock.invocationCallOrder[0]).toBeLessThan(test.conversation.completeTurn.mock.invocationCallOrder[0]!);
    expect(test.admission.sendPreparedText).not.toHaveBeenCalled();
    expect(test.conversation.applyDetectedLanguage).not.toHaveBeenCalled();
    expect(test.conversation.releaseTurn).not.toHaveBeenCalled();
    expect(test.logger.warn).toHaveBeenCalledWith("whatsapp.turn.terminal_failure", {
      conversationId: "conversation-1", observedVersion: 3, errorCode: code, outcome: "non-retryable-agent-failure",
    });
  });

  it.each([
    ["retryable host failure", new CommerceHostError("UNAVAILABLE", true)],
    ["unknown failure", new Error("unexpected agent failure")],
    ["untyped host-like failure", Object.assign(new Error("Commerce host: INVALID_FINAL"), { name: "CommerceHostError", code: "INVALID_FINAL", retryable: false })],
  ])("preserves repair eligibility for %s", async (_name, failure) => {
    const test = harness();
    test.runAgent.mockRejectedValue(failure);

    await expect(test.processor.process({ conversationId: "conversation-1", observedVersion: 3 })).rejects.toBe(failure);

    expect(test.admission.failPrepared).toHaveBeenCalledExactlyOnceWith("message-1");
    expect(test.conversation.completeTurn).not.toHaveBeenCalled();
    expect(test.conversation.releaseTurn).toHaveBeenCalledWith("conversation-1", 3);
    expect(test.admission.sendPreparedText).not.toHaveBeenCalled();
  });

  it("does not consume a terminal failure when reservation cleanup fails", async () => {
    const test = harness();
    const failure = new CommerceHostError("INVALID_FINAL", false);
    const cleanupError = new Error("cleanup database unavailable");
    test.runAgent.mockRejectedValue(failure);
    test.admission.failPrepared.mockRejectedValue(cleanupError);

    await expect(test.processor.process({ conversationId: "conversation-1", observedVersion: 3 })).rejects.toMatchObject({
      name: "AggregateError", message: "AI_TURN_CLEANUP_FAILED", cause: cleanupError, errors: [failure, cleanupError],
    });

    expect(test.conversation.completeTurn).not.toHaveBeenCalled();
    expect(test.conversation.releaseTurn).toHaveBeenCalledWith("conversation-1", 3);
  });

  it("keeps a terminal turn recoverable when durable completion fails", async () => {
    const test = harness();
    const failure = new CommerceHostError("INVALID_FINAL", false);
    const completionError = new Error("completion database unavailable");
    test.runAgent.mockRejectedValue(failure);
    test.conversation.completeTurn.mockRejectedValue(completionError);

    await expect(test.processor.process({ conversationId: "conversation-1", observedVersion: 3 })).rejects.toMatchObject({
      name: "AggregateError", message: "AI_TURN_TERMINAL_COMPLETION_FAILED", cause: completionError, errors: [failure, completionError],
    });

    expect(test.conversation.releaseTurn).toHaveBeenCalledWith("conversation-1", 3);
    expect(test.logger.warn).not.toHaveBeenCalled();
  });

  it("does not terminally consume a provider-send error even when it has a host error type", async () => {
    const test = harness();
    const failure = new CommerceHostError("UNAVAILABLE", false);
    test.admission.sendPreparedText.mockRejectedValue(failure);

    await expect(test.processor.process({ conversationId: "conversation-1", observedVersion: 3 })).rejects.toBe(failure);

    expect(test.admission.failPrepared).not.toHaveBeenCalled();
    expect(test.conversation.completeTurn).not.toHaveBeenCalled();
    expect(test.conversation.releaseTurn).toHaveBeenCalledWith("conversation-1", 3);
  });

  it("preserves and enqueues a newer inbound when terminal completion loses its version CAS", async () => {
    const test = harness();
    test.runAgent.mockRejectedValue(new CommerceHostError("INVALID_FINAL", false));
    test.conversation.completeTurn.mockResolvedValue(false);
    test.conversation.getTurnState
      .mockResolvedValueOnce(state({ pendingAiControlRevision: 7 }))
      .mockResolvedValue(state({ inboundVersion: 4, pendingAiControlRevision: 7 }));

    await test.processor.process({ conversationId: "conversation-1", observedVersion: 3 });

    expect(test.conversation.completeTurn).toHaveBeenCalledExactlyOnceWith("conversation-1", 3, 7);
    expect(test.conversation.suppressStaleTurn).toHaveBeenCalledWith("conversation-1", 3, 7);
    expect(test.queue.add).toHaveBeenCalledExactlyOnceWith("process-conversation-turn", {
      conversationId: "conversation-1", observedVersion: 4,
    }, expect.objectContaining({ jobId: "conversation-turn__conversation-1__4" }));
    expect(test.admission.sendPreparedText).not.toHaveBeenCalled();
  });

  it.each(["HUMAN", "AI"])("suppresses only the old revision after a concurrent %s control change", async (controlMode) => {
    const test = harness();
    test.runAgent.mockRejectedValue(new CommerceHostError("INVALID_FINAL", false));
    test.conversation.completeTurn.mockResolvedValue(false);
    test.conversation.getTurnState
      .mockResolvedValueOnce(state({ pendingAiControlRevision: 7, controlRevision: 7 }))
      .mockResolvedValue(state({ pendingAiControlRevision: null, pendingTurnStartedAt: null, controlRevision: 8, controlMode }));

    await test.processor.process({ conversationId: "conversation-1", observedVersion: 3 });

    expect(test.conversation.completeTurn).toHaveBeenCalledExactlyOnceWith("conversation-1", 3, 7);
    expect(test.conversation.suppressStaleTurn).toHaveBeenCalledExactlyOnceWith("conversation-1", 3, 7);
    expect(test.queue.add).not.toHaveBeenCalled();
    expect(test.admission.sendPreparedText).not.toHaveBeenCalled();
  });
}
