import type {
  RenderConversationResponseInput,
  WrapperRefusal,
  WrapperRenderResult,
} from "./contracts.js";

/**
 * Narrow adapter between the customer-visible AI turn and BG005. No provider,
 * authoring AST, moderation, billing or checkout access belongs here.
 *
 * A missing active slot is a deliberate unwrapped reply, while a configured
 * slot that cannot be safely rendered must never fall back to raw model text.
 */
export type AiOutboundComposition =
  | Readonly<{
      kind: "ready";
      text: string;
      wrapper: null | Readonly<{
        applicationKey: string;
        wrapperDefinitionId: string;
        localeId: string;
        slotEditVersion: number;
        replayed: boolean;
      }>;
    }>
  | Readonly<{ kind: "refused"; reason: WrapperRefusal }>;

export type AiConversationWrapper = Readonly<{
  renderConversationResponse(
    input: RenderConversationResponseInput,
  ): Promise<WrapperRenderResult>;
}>;

export async function composeAiOutbound(
  wrapper: AiConversationWrapper,
  input: Readonly<{
    conversationId: string;
    messageId: string;
    generatedResponse: string;
  }>,
): Promise<AiOutboundComposition> {
  const result = await wrapper.renderConversationResponse({
    conversationId: input.conversationId,
    messageIdentity: input.messageId,
    responseBody: input.generatedResponse,
    source: "AI",
    // BG005 reads the committed conversation language itself. Passing the
    // model's low-confidence guess here could contradict that durable choice.
  });
  if (result.kind === "rendered") {
    if (result.messageIdentity !== input.messageId || result.source !== "AI") {
      throw new Error("AI_WRAPPER_PROVENANCE_MISMATCH");
    }
    return {
      kind: "ready",
      text: result.body,
      wrapper: {
        applicationKey: result.applicationKey,
        wrapperDefinitionId: result.wrapperDefinitionId,
        localeId: result.localeId,
        slotEditVersion: result.slotEditVersion,
        replayed: result.replayed,
      },
    };
  }
  if (result.kind === "no-wrapper") {
    // No-wrapper must not silently rewrite the original AI response either.
    if (result.body !== input.generatedResponse) {
      throw new Error("AI_WRAPPER_PASSTHROUGH_MISMATCH");
    }
    return { kind: "ready", text: result.body, wrapper: null };
  }
  return { kind: "refused", reason: result.reason };
}
