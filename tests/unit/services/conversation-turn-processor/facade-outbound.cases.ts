import { expect, it } from "vitest";
import type { ConversationTurnFacadeContext } from "../conversation-turn-processor.service.test.js";

export function registerOutboundCases(context: ConversationTurnFacadeContext) {
  const { harness } = context;

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

  it("delivers one bounded referral for an ordinary evidence failure", async () => {
    const test = harness();
    test.runAgent.mockResolvedValue({
      answerKind: "REFER_TO_STORE",
      referralReason: "UNVERIFIABLE_FACTS",
      replyText: "Please contact the store directly.",
      detectedLanguageTag: null,
      detectedLanguageConfidence: null,
    });

    await test.processor.process({
      conversationId: "conversation-1",
      observedVersion: 3,
    });

    expect(test.admission.reserve).toHaveBeenCalledTimes(1);
    expect(test.admission.sendPreparedText).toHaveBeenCalledTimes(1);
    expect(test.admission.sendPreparedText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Please contact the store directly.",
      }),
    );
    expect(test.conversation.applyDetectedLanguage).toHaveBeenCalledTimes(1);
    expect(test.conversation.completeTurn).toHaveBeenCalledWith(
      "conversation-1",
      3,
    );
    expect(test.admission.failPrepared).not.toHaveBeenCalled();
  });
}
