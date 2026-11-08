import { exampleFinal } from "@modainteract/moda-interact-shared/commerce";
import type { CommercePresentationInput } from "../../../../src/services/conversation-wrappers/contracts.js";
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
  it("advances only after a composed length refusal and replays the selected candidate digest", async () => {
    const { service, read } = harness([slot("AI")]);
    const candidates = ["x".repeat(4090), "Compact complete reply."] as const;
    const first = await service.renderConversationResponse({ ...input, responseBody: candidates[0],
      hostComposedReplyCandidates: candidates });
    expect(first).toMatchObject({ kind: "rendered", responseDigest: digest(candidates[1]) });
    if (first.kind !== "rendered") return;
    expect(first.body).toContain(candidates[1]);
    read.loadContext.mockRejectedValue(new Error("replay must stay before reads"));
    expect(await service.renderConversationResponse({ ...input, responseBody: candidates[0],
      hostComposedReplyCandidates: candidates, previousApplication: first })).toMatchObject({ replayed: true });
  });
  it("rejects invalid or HUMAN candidate arrays before context reads", async () => {
    const { service, read } = harness([slot("AI")]);
    expect(await service.renderConversationResponse({ ...input, hostComposedReplyCandidates: ["Other"] }))
      .toEqual({ kind: "rejected", reason: "INVALID_INPUT" });
    expect(await service.renderConversationResponse({ ...input, source: "HUMAN", hostComposedReplyCandidates: [response] }))
      .toEqual({ kind: "rejected", reason: "INVALID_INPUT" });
    expect(read.loadContext).not.toHaveBeenCalled();
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

const presentation = (text: string): CommercePresentationInput => ({
  envelope: { ...exampleFinal, replyText: text },
  verified: { schemaVersion: 1, brandName: null, locale: "fr", disposition: "STANDARD",
    storeUrl: "https://shop.example", products: [], optionFacts: [], productFacts: [],
    requiresShipping: null, policyUrl: null, includeNoVerifiedOffer: false },
});
describe("ARCH-066 single Shared composition boundary", () => {
  it("normalizes explicit unwrapped AI text while leaving HUMAN behavior unchanged", async () => {
    const { service } = harness([]);
    const value = await service.renderConversationResponse({ ...input, responseBody: "**Hello**",
      commercePresentation: presentation("**Hello**") });
    expect(value).toMatchObject({ kind: "no-wrapper", body: "Hello" });
    expect(await service.renderConversationResponse({ ...input, source: "HUMAN" }))
      .toEqual({ kind: "unavailable", reason: "NOT_CONFIGURED" });
  });
  it("wraps exactly once and replays saved composition without revision reads", async () => {
    const { service, read } = harness([slot("AI")]);
    const typed = { ...input, commercePresentation: presentation(response) };
    const first = await service.renderConversationResponse(typed);
    expect(first).toMatchObject({ kind: "rendered", body: `Header\n${response}\nFooter` });
    if (first.kind !== "rendered") throw new Error("expected rendered");
    read.loadContext.mockRejectedValue(new Error("no reread"));
    read.loadSlots.mockRejectedValue(new Error("no revision reread"));
    expect(await service.renderConversationResponse({ ...typed, previousApplication: first }))
      .toEqual({ ...first, replayed: true });
    expect(await service.renderConversationResponse({ ...typed,
      commercePresentation: presentation("changed"), previousApplication: first }))
      .toEqual({ kind: "rejected", reason: "REPLAY_MISMATCH" });
  });
  it("refuses configured invalid projection, missing locale and untrusted brand", async () => {
    const typed = { ...input, commercePresentation: presentation(response) };
    expect(await harness([slot("AI", { preparedMissing: true })]).service.renderConversationResponse(typed))
      .toEqual({ kind: "rejected", reason: "PREPARED_MISSING" });
    const missing = slot("AI");
    expect(await harness([{ ...missing, definition: { ...missing.definition, locales: [] } }]).service.renderConversationResponse(typed))
      .toEqual({ kind: "rejected", reason: "LOCALE_UNAVAILABLE" });
    expect(await harness([]).service.renderConversationResponse({ ...typed,
      commercePresentation: { ...typed.commercePresentation, verified: { ...typed.commercePresentation.verified, brandName: "fabricated" } } }))
      .toEqual({ kind: "rejected", reason: "INVALID_INPUT" });
  });
  it("checks final total wrapper size at 4096 and refuses 4097", async () => {
    const { service } = harness([slot("AI")]);
    const overhead = "Header\n\nFooter".length;
    for (const length of [4096, 4097]) {
      const text = "x".repeat(length - overhead);
      const result = await service.renderConversationResponse({ ...input, responseBody: text, commercePresentation: presentation(text) });
      if (length === 4096) { expect(result.kind).toBe("rendered"); if (result.kind === "rendered") expect(result.body.length).toBe(4096); }
      else expect(result).toEqual({ kind: "rejected", reason: "OUTPUT_TOO_LONG" });
    }
  });
});
