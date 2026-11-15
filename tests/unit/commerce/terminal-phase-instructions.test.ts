import { describe, expect, it } from "vitest";
import { recoveryTerminalPhaseRequest, RECOVERY_TERMINAL_PHASE_INSTRUCTION } from "../../../src/commerce/terminal-phase-instructions.js";
import { RECOVERY_INSTRUCTIONS } from "../../../src/commerce/recovery-instructions.js";
import type { ModelRequest } from "@modainteract/moda-interact-shared/commerce/runner";
const request = { instructions: ["Pinned business rule: require discount inspection.", "APP_FORMAT_ONLY", ...RECOVERY_INSTRUCTIONS], context: {}, history: [], messages: [],
  requireToolCall: true, tools: [{ name: "recovery_complete_details", description: "Details", inputSchema: {} }] } as ModelRequest;
describe("application terminal phase instruction consistency", () => {
  it("replaces only exact app formatting while retaining every business/security/language authority", () => {
    const before = structuredClone(request); const result = recoveryTerminalPhaseRequest(request, ["APP_FORMAT_ONLY"]);
    expect(result.instructions).not.toContain("APP_FORMAT_ONLY"); expect(result.instructions).toContain(RECOVERY_TERMINAL_PHASE_INSTRUCTION);
    expect(result.instructions).toContain(request.instructions[0]);
    for (const owned of RECOVERY_INSTRUCTIONS) expect(result.instructions).toContain(owned.replace("after finalResponse", "after terminal completion"));
    expect(result.context).toBe(request.context); expect(result.tools).toBe(request.tools); expect(result.messages).toBe(request.messages);
    expect(request).toEqual(before);
  });
  it("leaves ordinary discovery/canonical requests byte-identical", () => {
    const ordinary = { ...request, requireToolCall: false }; expect(recoveryTerminalPhaseRequest(ordinary, ["APP_FORMAT_ONLY"])).toBe(ordinary);
  });
});
