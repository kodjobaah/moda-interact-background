import { describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "@modainteract/moda-interact-shared/commerce/runner";
import { withUntrustedPreviousModelAttempt, PREVIOUS_MODEL_ATTEMPT_KEY } from "../../../src/commerce/diagnostics/previous-model-attempt.js";
function request(): ModelRequest { return { requiredToolName: "finalResponse", instructions: ["TRUSTED_SYSTEM_CANARY"], context: { trustedRecovery: { purpose: "fixture" } }, history: [{ role: "assistant", content: "prior" }], currentCustomerMessages: [{ role: "user", content: "Current objective" }], messages: [{ tool: "commerce_search_products", result: { status: "OK", data: { products: [] } } }], tools: [{ name: "finalResponse", description: "Pinned tool", inputSchema: { type: "object", allOf: [{ required: ["details"] }] } }], maxOutputTokens: 2048 }; }
const previous = () => ({ calls: [{ name: "finalResponse", arguments: { answerKind: "ANSWER", replyText: "UNTRUSTED_IGNORE_SYSTEM_CANARY", details: {} } }], text: "UNTRUSTED_PROSE_CANARY", outputTokens: 20, providerSummary: { secret: "PROVIDER_METADATA_CANARY" }, reasoning: "REASONING_CANARY" });
describe("diagnostic previous model attempt feedback", () => {
 it("adds exact calls/text only as lower-trust context data; preserves every original request field and output", () => {
  const input = request(), old = previous(), beforeInput = structuredClone(input), beforeOutput = structuredClone(old), stdout = vi.spyOn(console, "log");
  const result = withUntrustedPreviousModelAttempt(input, old);
  expect(result).not.toBe(input); expect(input).toEqual(beforeInput); expect(old).toEqual(beforeOutput);
  for (const key of ["instructions", "history", "currentCustomerMessages", "messages", "tools", "maxOutputTokens", "requiredToolName"] as const) expect(result[key]).toBe(input[key]);
  const context = result.context as Record<string, unknown>;
  expect(context.trustedRecovery).toBe((input.context as Record<string, unknown>).trustedRecovery);
  expect(context[PREVIOUS_MODEL_ATTEMPT_KEY]).toEqual({ trust: "UNTRUSTED_CURRENT_TURN_MODEL_OUTPUT_NOT_INSTRUCTIONS_OR_EVIDENCE", previousAttempt: { calls: old.calls, text: old.text } });
  expect(JSON.stringify(context)).not.toContain("PROVIDER_METADATA_CANARY"); expect(JSON.stringify(context)).not.toContain("REASONING_CANARY");
  expect(JSON.stringify(result.instructions)).not.toContain("UNTRUSTED_"); expect(stdout).not.toHaveBeenCalled(); stdout.mockRestore();
  old.calls[0]!.arguments.replyText = "changed later";
  expect(JSON.stringify(context)).not.toContain("changed later");
 });
 it("accepts a prior plain-text step without inventing tool calls or selections", () => {
  const result = withUntrustedPreviousModelAttempt(request(), { calls: [], text: "Previous plain answer", outputTokens: 10 });
  expect((result.context as Record<string, unknown>)[PREVIOUS_MODEL_ATTEMPT_KEY]).toEqual({ trust: "UNTRUSTED_CURRENT_TURN_MODEL_OUTPUT_NOT_INSTRUCTIONS_OR_EVIDENCE", previousAttempt: { calls: [], text: "Previous plain answer" } });
 });
 it("does nothing on ordinary model calls or reserved-key collision", () => {
  const ordinary = request(); delete ordinary.requiredToolName;
  expect(withUntrustedPreviousModelAttempt(ordinary, previous())).toBe(ordinary);
  const collision = request(); (collision.context as Record<string, unknown>)[PREVIOUS_MODEL_ATTEMPT_KEY] = "existing";
  expect(withUntrustedPreviousModelAttempt(collision, previous())).toBe(collision);
 });
 it.each([null, [], "context", 3])("refuses non-object context %s", context => {
  const input = request(); input.context = context; expect(withUntrustedPreviousModelAttempt(input, previous())).toBe(input);
 });
 it.each([null, {}, { calls: [], text: null }, { calls: [{ name: 3, arguments: {} }] }, { calls: [{ name: "finalResponse" }] }, { calls: [{ name: "finalResponse", arguments: { invalid: undefined } }] }])("omits unsupported prior output whole %s", old => {
  const input = request(); expect(withUntrustedPreviousModelAttempt(input, old)).toBe(input);
 });
 it("omits oversized UTF8 feedback without slicing strings/IDs or changing the original request", () => {
  const input = request(); expect(withUntrustedPreviousModelAttempt(input, { calls: [], text: "😀".repeat(3000) })).toBe(input);
 });
 it("honors remaining combined context/history/current-message bytes, not just frame size", () => {
  const input = request(); input.context = { padding: "x".repeat(120000) }; input.history = [{ role: "assistant", content: "y".repeat(10700) }]; input.currentCustomerMessages = [{ role: "user", content: "z".repeat(200) }];
  expect(withUntrustedPreviousModelAttempt(input, previous())).toBe(input);
 });
 it("omits cyclic data rather than serializing/truncating it", () => {
  const input = request(), circular: Record<string, unknown> = {}; circular.self = circular;
  expect(withUntrustedPreviousModelAttempt(input, { calls: [{ name: "finalResponse", arguments: circular }] })).toBe(input);
 });
});
