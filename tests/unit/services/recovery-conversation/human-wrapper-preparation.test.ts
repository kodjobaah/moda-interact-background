import { describe, expect, it, vi } from "vitest";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { WrappedResult, WrapperRenderResult } from "../../../../src/services/conversation-wrappers/contracts.js";
import { HumanWrapperPreparationService } from
  "../../../../src/services/recovery-conversation/human-wrapper-preparation.service.js";

const command = {
  id: "merchant-command-1", conversationId: "recovery-conversation-1",
  kind: "HUMAN_TEXT" as const, textBody: "I can help with your order.",
};

const wrapped: WrappedResult = {
  kind: "rendered", body: `Welcome to our shop.\n${command.textBody}\nThanks!`,
  wrapperDefinitionId: "definition-human", localeId: "locale-en", audience: "HUMAN",
  slotEditVersion: 7, languageTag: "en", contentHash: "a".repeat(64),
  messageIdentity: command.id, source: "HUMAN", applicationKey: "key", responseDigest: "digest", replayed: false,
};

function harness(result: unknown) {
  const renderConversationResponse = vi.fn(async () => result as WrapperRenderResult);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child() { return this; } } as unknown as StructuredLogger;
  const service = new HumanWrapperPreparationService({ renderConversationResponse }, logger);
  return { service, renderConversationResponse, logger };
}

describe("ARCH-047-BG009 human wrapper preparation (no send admission)", () => {
  it("resolves HUMAN with stable command identity and leaves the original response intact", async () => {
    const x = harness(wrapped);
    expect(await x.service.prepare(command)).toEqual({ kind: "prepared", body: wrapped.body, application: wrapped });
    expect(x.renderConversationResponse).toHaveBeenCalledWith({
      source: "HUMAN", conversationId: command.conversationId,
      messageIdentity: command.id, responseBody: command.textBody,
    });
    expect(command.textBody).toBe("I can help with your order.");
  });

  it("uses exact raw text only when BG005 explicitly reports no configured slot", async () => {
    const x = harness({ kind: "no-wrapper", reason: "NOT_CONFIGURED", body: command.textBody });
    expect(await x.service.prepare(command)).toEqual({ kind: "passthrough", body: command.textBody });
    const bad = harness({ kind: "no-wrapper", reason: "NOT_CONFIGURED", body: "wrong text" });
    expect(await bad.service.prepare(command)).toEqual({ kind: "refused", reason: "CONTENT_MISMATCH" });
  });

  it("does not wrap a post-window Meta template command", async () => {
    const x = harness(wrapped);
    expect(await x.service.prepare({ ...command, kind: "RECOVERY_FOLLOW_UP_TEMPLATE", textBody: null }))
      .toEqual({ kind: "not-applicable" });
    expect(x.renderConversationResponse).not.toHaveBeenCalled();
  });

  it("rejects unsafe wrapper projection, invalid context and stale/mismatched render identity", async () => {
    for (const reason of ["PREPARED_INVALID", "TENANT_MISMATCH", "OUTPUT_TOO_LONG", "ALREADY_WRAPPED"] as const) {
      const x = harness({ kind: "rejected", reason });
      expect(await x.service.prepare(command)).toEqual({ kind: "refused", reason });
    }
    const mismatch = harness({ ...wrapped, messageIdentity: "different-command" });
    expect(await mismatch.service.prepare(command)).toEqual({ kind: "refused", reason: "CONTENT_MISMATCH" });
    const unavailable = harness({ kind: "unavailable", reason: "CONVERSATION_UNAVAILABLE" });
    expect(await unavailable.service.prepare(command)).toEqual({ kind: "refused", reason: "CONVERSATION_UNAVAILABLE" });
  });

  it("logs unexpected exceptions through Shared and propagates them without revealing content", async () => {
    const x = harness(null);
    const failure = new Error("sensitive checkout URL must not appear in logs");
    vi.mocked(x.renderConversationResponse).mockRejectedValue(failure);
    await expect(x.service.prepare(command)).rejects.toBe(failure);
    expect(x.logger.error).toHaveBeenCalledWith("arch047.human_wrapper.prepare_failed", {
      commandId: command.id, errorType: "Error",
    });
    expect(JSON.stringify(vi.mocked(x.logger.error).mock.calls)).not.toContain("sensitive checkout URL");
  });
});
