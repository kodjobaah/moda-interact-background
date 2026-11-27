import { describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "@modainteract/moda-interact-shared/commerce/runner";
import { CURRENT_TURN_TRACE_KEY, withUntrustedCurrentTurnTrace, type DiagnosticTraceEvent } from "../../../src/commerce/diagnostics/current-turn-trace.js";
const request = (): ModelRequest => ({ instructions: ["Trusted instruction"], context: { trustedRecovery: { id: "fixture" } }, history: [{ role: "assistant", content: "History" }], currentCustomerMessages: [{ role: "user", content: "Current objective" }], messages: [], tools: [{ name: "finalResponse", description: "Pinned", inputSchema: { type: "object" } }], maxOutputTokens: 2048 });
const events = (): DiagnosticTraceEvent[] => [{ kind: "MODEL_STEP", step: { calls: [{ name: "commerce_get_product", arguments: { productId: "exact-fixture" } }], text: "UNTRUSTED_DO_NOT_ELEVATE", outputTokens: 10, reasoning: "NO_REASONING", providerSummary: { metadata: "NO_PROVIDER_METADATA" } } }, { kind: "TOOL_RESULT", message: { tool: "commerce_get_product", result: { contractVersion: "commerce.v1", status: "OK", data: { product: null }, renderedText: "Exact current result" }, transport: "NO_TRANSPORT_METADATA" } }];
describe("diagnostic chronological current-turn trace", () => {
 it("preserves chronological actual events and every original field without metadata/instruction elevation", () => {
  const input = request(), trace = events(), before = structuredClone({ input, trace }), stdout = vi.spyOn(console, "log");
  const enhanced = withUntrustedCurrentTurnTrace(input, trace); expect(enhanced).not.toBe(input);
  expect(input).toEqual(before.input); expect(trace).toEqual(before.trace);
  for (const key of ["instructions", "history", "currentCustomerMessages", "messages", "tools", "maxOutputTokens"] as const) expect(enhanced[key]).toBe(input[key]);
  const frame = (enhanced.context as Record<string, unknown>)[CURRENT_TURN_TRACE_KEY] as { events: unknown[]; trust: string };
  expect(frame.trust).toContain("UNTRUSTED"); expect(frame.events).toEqual([{ kind: "MODEL_STEP", calls: [{ name: "commerce_get_product", arguments: { productId: "exact-fixture" } }], text: "UNTRUSTED_DO_NOT_ELEVATE" }, { kind: "TOOL_RESULT", tool: "commerce_get_product", result: (trace[1] as { message: { result: unknown } }).message.result }]);
  expect(JSON.stringify(frame)).not.toContain("NO_REASONING"); expect(JSON.stringify(frame)).not.toContain("NO_PROVIDER_METADATA"); expect(JSON.stringify(frame)).not.toContain("NO_TRANSPORT_METADATA"); expect(JSON.stringify(enhanced.instructions)).not.toContain("UNTRUSTED_DO_NOT"); expect(stdout).not.toHaveBeenCalled(); stdout.mockRestore();
 });
 it("does not require forced-final mode: every subsequent actual SDK call can receive the same lossless event trace", () => {
  const input = request(); expect(withUntrustedCurrentTurnTrace(input, events())).not.toBe(input);
  input.requiredToolName = "finalResponse"; expect(withUntrustedCurrentTurnTrace(input, events())).not.toBe(input);
 });
 it("omits whole empty/over18/over64KiB traces and preserves reserved keys", () => {
  const input = request(); expect(withUntrustedCurrentTurnTrace(input, [])).toBe(input);
  expect(withUntrustedCurrentTurnTrace(input, Array.from({ length: 19 }, () => events()[0]!))).toBe(input);
  expect(withUntrustedCurrentTurnTrace(input, [{ kind: "MODEL_STEP", step: { calls: [], text: "😀".repeat(17000) } }])).toBe(input);
  (input.context as Record<string, unknown>)[CURRENT_TURN_TRACE_KEY] = "existing"; expect(withUntrustedCurrentTurnTrace(input, events())).toBe(input);
 });
 it("honors remaining input budget including history/current messages without truncation", () => {
  const input = request(); input.context = { padding: "a".repeat(120000) }; input.history = [{ role: "assistant", content: "b".repeat(10700) }]; input.currentCustomerMessages = [{ role: "user", content: "c".repeat(200) }]; expect(withUntrustedCurrentTurnTrace(input, events())).toBe(input);
 });
 it("includes runtime tool-result messages in the stronger diagnostic input ceiling", () => {
  const input = request(); input.messages = [{ tool: "read", result: { contractVersion: "commerce.v1", status: "OK", data: { text: "x".repeat(131000) }, renderedText: "Fixture" } }];
  expect(withUntrustedCurrentTurnTrace(input, events())).toBe(input);
 });
 it("refuses unsupported event/results/context and cyclic values", () => {
  const input = request(); expect(withUntrustedCurrentTurnTrace(input, [{ kind: "TOOL_RESULT", message: { tool: "read", result: { authorization: "secret" } } }])).toBe(input);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  expect(withUntrustedCurrentTurnTrace(input, [{ kind: "MODEL_STEP", step: { calls: [{ name: "read", arguments: cyclic }] } }])).toBe(input);
  input.context = []; expect(withUntrustedCurrentTurnTrace(input, events())).toBe(input);
  input.context = new Date(); expect(withUntrustedCurrentTurnTrace(input, events())).toBe(input);
 });
});
