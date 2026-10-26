import { describe, expect, it, vi } from "vitest";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { ConversationWrapperService } from "../../../../src/services/conversation-wrappers/service.js";
import { digest, stableJson } from "../../../../src/services/conversation-wrappers/projection.js";
import { chooseSlot, languageChoices } from "../../../../src/services/conversation-wrappers/selection.js";
import type {
  PreparedWrapper, VerifiedWrapperContext, WrapperReadPort, WrapperSlot,
} from "../../../../src/services/conversation-wrappers/contracts.js";

const response = "Original user-facing answer.";
const prepared: PreparedWrapper = {
  schemaVersion: 1, family: "MODA_CONVERSATION_WRAPPER", responseSlot: "response.body",
  header: [{ kind: "text", value: "Header" }], body: [{ kind: "responseSlot", name: "response.body" }],
  footer: [{ kind: "text", value: "Footer" }], conditionals: [],
};
const context: VerifiedWrapperContext = { conversationId: "conversation", shopId: "shop",
  conversationLanguageTag: "fr", merchantLanguageTag: "en", variables: {}, checkoutAvailable: false };
function slot(audience: "AI" | "HUMAN" | "SHARED", params: { published?: boolean; wrongKind?: boolean; preparedMissing?: boolean } = {}): WrapperSlot {
  const contentHash = digest(stableJson(prepared));
  return { audience, definitionId: `${audience}-def`, editVersion: 3, definition: {
    id: `${audience}-def`, kind: params.wrongKind ? "META_RECOVERY" : "MODA_CONVERSATION_WRAPPER",
    audience, status: "PUBLISHED", sourceLanguageTag: "en", astSchemaVersion: 1,
    sourceHash: "a".repeat(64), publishedAt: params.published === false ? null : new Date(),
    retiredAt: null, createdByAdminId: "platform-admin", locales: [
      { id: `${audience}-en`, languageTag: "en", status: "SOURCE_SAVED", providerLanguageCode: null,
        localeAst: { schemaVersion: 1, prepared }, contentHash,
        reviewedAt: null, reviewedByAdminId: null },
      { id: `${audience}-fr`, languageTag: "fr", status: "REVIEWED", providerLanguageCode: null,
        localeAst: params.preparedMissing ? { schemaVersion: 1 } : { schemaVersion: 1, prepared }, contentHash,
        reviewedAt: new Date(), reviewedByAdminId: "platform-admin" },
    ],
  } };
}
function harness(slots: WrapperSlot[], current: VerifiedWrapperContext | "TENANT_MISMATCH" | null = context) {
  const read = {
    loadContext: vi.fn(async () => current), loadSlots: vi.fn(async () => slots),
  } satisfies WrapperReadPort;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as unknown as StructuredLogger;
  const service = new ConversationWrapperService({ repository: read, logger });
  return { read, logger, service };
}
const input = { conversationId: "conversation", source: "AI" as const,
  messageIdentity: "outbound:one", responseBody: response };

describe("ARCH-047 BG005 selection and facade", () => {
  it("applies AI/HUMAN override, then SHARED, without fallback from invalid override", async () => {
    const { service } = harness([slot("SHARED"), slot("AI")]);
    const ai = await service.renderConversationResponse(input);
    expect(ai).toMatchObject({ kind: "rendered", wrapperDefinitionId: "AI-def", localeId: "AI-fr" });
    const human = await service.renderConversationResponse({ ...input, source: "HUMAN" });
    expect(human).toMatchObject({ kind: "rendered", wrapperDefinitionId: "SHARED-def" });
    const wrong = harness([slot("SHARED"), slot("AI", { wrongKind: true })]);
    expect(await wrong.service.renderConversationResponse(input))
      .toEqual({ kind: "rejected", reason: "DEFINITION_UNAVAILABLE" });
  });
  it("checks active definition publication, locale readiness and prepared projection", async () => {
    for (const [chosen, reason] of [
      [slot("AI", { published: false }), "DEFINITION_UNAVAILABLE"],
      [slot("AI", { preparedMissing: true }), "PREPARED_MISSING"],
    ] as const) {
      const service = harness([chosen]).service;
      expect(await service.renderConversationResponse(input)).toEqual({ kind: "rejected", reason });
    }
  });
  it("uses stored conversation language and merchant fallback only for unavailable locale", async () => {
    expect(languageChoices({ conversationTag: "fr-CA", merchantTag: "en", preferredTag: null,
      platformFallbackTag: null })).toEqual(["fr-CA", "fr", "en"]);
    expect(languageChoices({ conversationTag: "de", merchantTag: "en", preferredTag: "en",
      platformFallbackTag: null })).toBe("invalid");
    expect(chooseSlot([slot("SHARED")], "AI")).toMatchObject({ audience: "SHARED" });
    const { service } = harness([slot("SHARED")], { ...context, conversationLanguageTag: "de" });
    expect(await service.renderConversationResponse(input)).toMatchObject({ kind: "rendered", languageTag: "en" });
  });
  it("replays deterministic message output without consulting changed active slots", async () => {
    const { service, read } = harness([slot("AI")]);
    const first = await service.renderConversationResponse(input);
    expect(first.kind).toBe("rendered");
    if (first.kind !== "rendered") return;
    expect(first.body).toContain(response);
    expect((await service.renderConversationResponse(input))).toMatchObject({
      kind: "rendered", applicationKey: first.applicationKey, body: first.body,
    });
    read.loadSlots.mockRejectedValue(new Error("should not be called"));
    const replay = await service.renderConversationResponse({ ...input, previousApplication: first });
    expect(replay).toMatchObject({ ...first, replayed: true });
    expect(await service.renderConversationResponse({ ...input, responseBody: "Different",
      previousApplication: first })).toEqual({ kind: "rejected", reason: "REPLAY_MISMATCH" });
  });
  it("does not bypass tenant scoping or permit empty malformed inputs", async () => {
    const { service, read } = harness([slot("SHARED")], "TENANT_MISMATCH");
    expect(await service.renderConversationResponse(input)).toEqual({ kind: "rejected", reason: "TENANT_MISMATCH" });
    expect(read.loadSlots).not.toHaveBeenCalled();
    expect(await service.renderConversationResponse({ ...input, messageIdentity: "" }))
      .toEqual({ kind: "rejected", reason: "INVALID_INPUT" });
  });
  it("supports explicit no-wrapper passthrough, which does not claim admission", async () => {
    const read = { loadContext: async () => context, loadSlots: async () => [] } satisfies WrapperReadPort;
    const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as unknown as StructuredLogger;
    const service = new ConversationWrapperService({ repository: read, logger, onMissingSlot: "passthrough" });
    expect(await service.renderConversationResponse(input)).toEqual({ kind: "no-wrapper", body: response, reason: "NOT_CONFIGURED" });
    expect(await harness([]).service.renderConversationResponse(input)).toEqual({ kind: "unavailable", reason: "NOT_CONFIGURED" });
  });
  it("logs exceptions through shared-logger interface and rethrows, never swallows", async () => {
    const { service, read, logger } = harness([slot("AI")]);
    read.loadSlots.mockRejectedValue(new Error("do not leak customer URLs"));
    await expect(service.renderConversationResponse(input)).rejects.toThrow("do not leak customer URLs");
    expect(logger.error).toHaveBeenCalledWith("conversation_wrapper.render_exception", expect.objectContaining({
      errorType: "Error", conversationId: "conversation",
    }));
    expect(JSON.stringify((logger.error as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("do not leak customer URLs");
  });
});
