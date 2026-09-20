// The legacy local-product-tool live test is superseded by the real MCP SDK
// interoperability fixture. Never auto-run a live model merely because a key
// happens to be present in the developer's environment.
import { expect, it, vi } from "vitest";
import { modelAdapter } from "../../src/commerce/host.js";
import { generateText } from "ai";
vi.mock("../../src/lib/db.js", () => ({ default: {} }));
vi.mock("ai", async (original) => ({
  ...(await original<typeof import("ai")>()),
  generateText: vi.fn(),
}));
it("adapts a dynamic AI SDK tool call without executing a local tool or forcing final-after-search", async () => {
  vi.mocked(generateText).mockResolvedValue({
    toolCalls: [{ toolName: "new_tool", input: { query: "linen" } }],
    usage: { outputTokens: 12 },
  } as any);
  const result = await modelAdapter({} as any).invoke(
    {
      instructions: ["fixed"],
      context: { status: "COMPLETED" },
      history: [],
      messages: [],
      tools: [
        {
          name: "new_tool",
          description: "new",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
      maxOutputTokens: 800,
    },
    new AbortController().signal,
  );
  expect(result).toEqual({
    calls: [{ name: "new_tool", arguments: { query: "linen" } }],
    outputTokens: 12,
  });
  const options = vi.mocked(generateText).mock.calls[0]![0];
  expect(options.tools?.new_tool).not.toHaveProperty("execute");
  expect(options).not.toHaveProperty("prepareStep");
  expect(options.abortSignal).toBeInstanceOf(AbortSignal);
});
