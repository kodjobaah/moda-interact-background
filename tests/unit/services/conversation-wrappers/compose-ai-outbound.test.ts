import { describe, expect, it, vi } from "vitest";
import { composeAiOutbound } from "../../../../src/services/conversation-wrappers/compose-ai-outbound.js";
import type { AiConversationWrapper } from "../../../../src/services/conversation-wrappers/compose-ai-outbound.js";

const input = {
  conversationId: "conversation-1",
  messageId: "reserved-message-1",
  generatedResponse: "Yes, we can help with this item.",
};

describe("ARCH-047-BG008 prepared AI outbound composition", () => {
  it("passes the unmodified model answer and stable reserved-message identity to BG005", async () => {
    const render = vi.fn(async () => ({ kind: "no-wrapper" as const,
      body: input.generatedResponse, reason: "NOT_CONFIGURED" as const }));
    const composition = await composeAiOutbound({ renderConversationResponse: render }, input);
    expect(render).toHaveBeenCalledExactlyOnceWith({
      conversationId: input.conversationId,
      messageIdentity: input.messageId,
      responseBody: input.generatedResponse,
      source: "AI",
    });
    expect(composition).toEqual({ kind: "ready", text: input.generatedResponse, wrapper: null });
  });

  it("returns rendered content and bounded provenance, never modifying the raw agent answer", async () => {
    const wrapper: AiConversationWrapper = { renderConversationResponse: async () => ({
      kind: "rendered", body: `Welcome! ${input.generatedResponse} Goodbye!`,
      wrapperDefinitionId: "definition-1", localeId: "locale-fr", audience: "AI",
      slotEditVersion: 2, languageTag: "fr", contentHash: "digest", source: "AI",
      messageIdentity: input.messageId, applicationKey: "application-1", responseDigest: "digest",
      replayed: false,
    }) };
    expect(await composeAiOutbound(wrapper, input)).toEqual({ kind: "ready",
      text: `Welcome! ${input.generatedResponse} Goodbye!`,
      wrapper: { applicationKey: "application-1", wrapperDefinitionId: "definition-1",
        localeId: "locale-fr", slotEditVersion: 2, replayed: false },
    });
  });

  it.each(["rejected", "unavailable"] as const)("fails closed for %s, not raw passthrough", async (kind) => {
    const wrapper: AiConversationWrapper = { renderConversationResponse: async () => ({ kind,
      reason: "LOCALE_UNAVAILABLE" }) };
    expect(await composeAiOutbound(wrapper, input))
      .toEqual({ kind: "refused", reason: "LOCALE_UNAVAILABLE" });
  });

  it("rejects fabricated no-wrapper text rather than permitting another composition path", async () => {
    const wrapper: AiConversationWrapper = { renderConversationResponse: async () => ({
      kind: "no-wrapper", reason: "NOT_CONFIGURED", body: "rewritten reply",
    }) };
    await expect(composeAiOutbound(wrapper, input)).rejects.toThrow("AI_WRAPPER_PASSTHROUGH_MISMATCH");
  });

  it.each([
    { source: "HUMAN" as const, messageIdentity: input.messageId },
    { source: "AI" as const, messageIdentity: "a-different-message" },
  ])("rejects wrapper provenance belonging to another source/identity: %j", async ({ source, messageIdentity }) => {
    const wrapper: AiConversationWrapper = { renderConversationResponse: async () => ({
      kind: "rendered", body: input.generatedResponse,
      wrapperDefinitionId: "definition-1", localeId: "locale-en", audience: "SHARED",
      slotEditVersion: 1, languageTag: "en", contentHash: "digest", source,
      messageIdentity, applicationKey: "key", responseDigest: "digest", replayed: false,
    }) };
    await expect(composeAiOutbound(wrapper, input)).rejects.toThrow("AI_WRAPPER_PROVENANCE_MISMATCH");
  });

  it("propagates renderer exceptions; upstream worker must log and retry", async () => {
    const failed = new Error("database unavailable");
    const wrapper: AiConversationWrapper = { renderConversationResponse: async () => { throw failed; } };
    await expect(composeAiOutbound(wrapper, input)).rejects.toBe(failed);
  });
});
