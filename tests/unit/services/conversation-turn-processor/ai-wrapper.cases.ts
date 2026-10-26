import { expect, it, vi } from "vitest";
import type { ConversationTurnFacadeContext } from "../conversation-turn-processor.service.test.js";

/** The real delivery service persists and moderates input.text before Meta. */
export function registerAiWrapperCases(context: ConversationTurnFacadeContext) {
  const { harness, ConversationTurnProcessor, first, state } = context;
  const rendered = (body: string) => ({
    kind: "rendered" as const, body,
    source: "AI" as const, messageIdentity: "message-1",
    wrapperDefinitionId: "published-ai", localeId: "locale-en", audience: "AI" as const,
    slotEditVersion: 7, languageTag: "en", contentHash: "hash",
    applicationKey: "application-key", responseDigest: "response-hash", replayed: false,
  });

  it("sends exactly one fully composed AI reply, retaining original response and message identity", async () => {
    const test = harness();
    test.aiWrapper.renderConversationResponse.mockResolvedValue(rendered("Shop: reply. Visit the checkout."));
    await test.processor.process({ conversationId: "conversation-1", observedVersion: 3 });
    expect(test.runAgent).toHaveBeenCalledOnce();
    expect(test.aiWrapper.renderConversationResponse).toHaveBeenCalledExactlyOnceWith({
      conversationId: "conversation-1", messageIdentity: "message-1",
      responseBody: "reply", source: "AI",
    });
    expect(test.admission.sendPreparedText).toHaveBeenCalledOnce();
    expect(test.admission.sendPreparedText).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "message-1", text: "Shop: reply. Visit the checkout.",
    }));
    expect(test.logger.info).toHaveBeenCalledWith("whatsapp.turn.ai_wrapper_composed", expect.objectContaining({
      applicationKey: "application-key", wrapperDefinitionId: "published-ai", slotEditVersion: 7,
    }));
    expect(test.conversation.completeTurn).toHaveBeenCalledWith("conversation-1", 3);
  });

  it("passes through only when BG005 reports no published wrapper, using the same outbound path", async () => {
    const test = harness();
    await test.processor.process({ conversationId: "conversation-1", observedVersion: 3 });
    expect(test.admission.sendPreparedText).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "reply" }));
    expect(test.aiWrapper.renderConversationResponse).toHaveBeenCalledOnce();
  });

  it.each(["rejected", "unavailable"] as const)("fails closed for %s wrapper projection", async (kind) => {
    const test = harness();
    test.aiWrapper.renderConversationResponse.mockResolvedValue({ kind,
      reason: "PREPARED_MISSING" });
    await test.processor.process({ conversationId: "conversation-1", observedVersion: 3 });
    expect(test.admission.sendPreparedText).not.toHaveBeenCalled();
    expect(test.admission.failPrepared).toHaveBeenCalledExactlyOnceWith("message-1");
    expect(test.conversation.completeTurn).toHaveBeenCalledWith("conversation-1", 3);
    expect(test.logger.warn).toHaveBeenCalledWith("whatsapp.turn.ai_wrapper_refused", expect.objectContaining({
      reason: "PREPARED_MISSING",
    }));
  });

  it("logs and propagates a BG005 database exception; no raw-text fallback", async () => {
    const test = harness();
    const failed = new Error("wrapper lookup failed");
    test.aiWrapper.renderConversationResponse.mockRejectedValue(failed);
    await expect(test.processor.process({ conversationId: "conversation-1", observedVersion: 3 }))
      .rejects.toBe(failed);
    expect(test.logger.error).toHaveBeenCalledWith("whatsapp.turn.processing_failed", expect.objectContaining({
      errorName: "Error",
    }));
    expect(test.admission.failPrepared).toHaveBeenCalledWith("message-1");
    expect(test.admission.sendPreparedText).not.toHaveBeenCalled();
    expect(test.conversation.releaseTurn).toHaveBeenCalled();
  });

  it("logs and propagates cleanup exceptions without hiding the original failure", async () => {
    const test = harness();
    const originalError = new Error("lookup failure");
    const cleanupError = new Error("cleanup failure");
    test.aiWrapper.renderConversationResponse.mockRejectedValue(originalError);
    test.admission.failPrepared.mockRejectedValue(cleanupError);
    let thrown: unknown;
    try {
      await test.processor.process({ conversationId: "conversation-1", observedVersion: 3 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.message).toBe("AI_TURN_CLEANUP_FAILED");
    expect(aggregate.errors).toEqual([originalError, cleanupError]);
    expect(aggregate.cause).toBe(cleanupError);
    expect(test.logger.error).toHaveBeenCalledWith("whatsapp.turn.cleanup_failed", expect.objectContaining({
      errorMessage: "cleanup failure",
    }));
    expect(test.admission.sendPreparedText).not.toHaveBeenCalled();
  });

  it("does not send when a customer turn changes while BG005 awaits its database read", async () => {
    const test = harness();
    test.aiWrapper.renderConversationResponse.mockResolvedValue(rendered("wrapped reply"));
    test.conversation.hasChanged.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    test.conversation.getTurnState.mockResolvedValueOnce(state())
      .mockResolvedValueOnce(state({ inboundVersion: 4 }));
    await test.processor.process({ conversationId: "conversation-1", observedVersion: 3 });
    expect(test.admission.sendPreparedText).not.toHaveBeenCalled();
    expect(test.admission.failPrepared).toHaveBeenCalledWith("message-1");
    expect(test.queue.add).toHaveBeenCalledWith("process-conversation-turn",
      { conversationId: "conversation-1", observedVersion: 4 }, expect.anything());
  });

  it("does not send after HUMAN takeover during the awaited wrapper read", async () => {
    const test = harness();
    const ownership = {
      readTurnOwnership: vi.fn().mockResolvedValue({ revision: 9 }),
      checkAutomatedTurn: vi.fn().mockResolvedValueOnce({ kind: "allowed" })
        .mockResolvedValueOnce({ kind: "allowed" })
        .mockResolvedValueOnce({ kind: "suppressed", reason: "stale-control-revision" }),
    };
    const processor = new ConversationTurnProcessor({
      queue: test.queue, conversation: test.conversation, admission: test.admission,
      abuseAdmission: test.abuseAdmission, loadTurn: vi.fn().mockResolvedValue(test.loaded),
      runAgent: test.runAgent, aiWrapper: test.aiWrapper, ownership,
      getResult: (result: { replyText: string; detectedLanguageTag: null; detectedLanguageConfidence: null }) => result,
      now: () => new Date(first.getTime() + 20_000), runtimeConfig: test.runtimeConfig,
      logger: test.logger,
    });
    test.aiWrapper.renderConversationResponse.mockResolvedValue(rendered("should never send"));
    await processor.process({ conversationId: "conversation-1", observedVersion: 3 });
    expect(ownership.checkAutomatedTurn).toHaveBeenCalledTimes(3);
    expect(test.admission.sendPreparedText).not.toHaveBeenCalled();
    expect(test.admission.failPrepared).toHaveBeenCalledWith("message-1");
  });

  it("does not compose or send another reply on redelivery of the same turn", async () => {
    const test = harness();
    await test.processor.process({ conversationId: "conversation-1", observedVersion: 3 });
    test.admission.reserve.mockResolvedValue({ kind: "suppressed", reason: "duplicate" });
    await test.processor.process({ conversationId: "conversation-1", observedVersion: 3 });
    expect(test.runAgent).toHaveBeenCalledTimes(1);
    expect(test.aiWrapper.renderConversationResponse).toHaveBeenCalledTimes(1);
    expect(test.admission.sendPreparedText).toHaveBeenCalledTimes(1);
  });

  it("sends only fully rendered content to the downstream moderation boundary", async () => {
    const test = harness();
    const provider = vi.fn();
    const moderateWholeText = vi.fn(async (text: string) => !text.includes("forbidden-wrapper-text"));
    test.aiWrapper.renderConversationResponse.mockResolvedValue(rendered("forbidden-wrapper-text reply"));
    test.admission.sendPreparedText.mockImplementation(async (admitted: { text: string }) => {
      if (await moderateWholeText(admitted.text)) await provider(admitted.text);
      return { kind: "suppressed" as const, reason: "conversation-invalid" as const };
    });
    await test.processor.process({ conversationId: "conversation-1", observedVersion: 3 });
    expect(moderateWholeText).toHaveBeenCalledWith("forbidden-wrapper-text reply");
    expect(provider).not.toHaveBeenCalled();
    expect(test.admission.sendPreparedText).toHaveBeenCalledTimes(1);
  });

  it("does not wrap deterministic terminal text or the non-model clarification path", async () => {
    const terminal = harness();
    terminal.admission.reserve.mockResolvedValue({ kind: "admitted", messageId: "terminal",
      conversationId: "conversation-1", terminal: true });
    await terminal.processor.process({ conversationId: "conversation-1", observedVersion: 3 });
    expect(terminal.aiWrapper.renderConversationResponse).not.toHaveBeenCalled();
    const clarification = harness();
    clarification.loaded.clarificationText = "Please clarify";
    const processor = new ConversationTurnProcessor({
      queue: clarification.queue, conversation: clarification.conversation,
      admission: clarification.admission, abuseAdmission: clarification.abuseAdmission,
      loadTurn: vi.fn().mockResolvedValue(clarification.loaded),
      runAgent: clarification.runAgent, aiWrapper: clarification.aiWrapper,
      getResult: (result: { replyText: string; detectedLanguageTag: null; detectedLanguageConfidence: null }) => result,
      now: () => new Date(first.getTime() + 20_000), runtimeConfig: clarification.runtimeConfig,
      logger: clarification.logger,
    });
    await processor.process({ conversationId: "conversation-1", observedVersion: 3 });
    expect(clarification.aiWrapper.renderConversationResponse).not.toHaveBeenCalled();
    expect(clarification.admission.sendPreparedText).toHaveBeenCalledTimes(1);
  });
}
