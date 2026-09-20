import { expect, it, vi } from "vitest";
const run = vi.hoisted(() =>
  vi.fn(async () => ({
    replyText: "From the MCP host",
    detectedLanguageTag: null,
    detectedLanguageConfidence: null,
  })),
);
vi.mock("../../../src/agents/commerce.agent.js", () => ({
  runCommerceAgent: run,
}));
import { createCommerceAgentPipeline } from "../../../src/agents/commerce.agent.pipeline.js";
it("the optional pipeline delegates to the same generic host", async () => {
  const context = { recovery: { id: "real-recovery" } } as any;
  const result = await createCommerceAgentPipeline().invoke({ context });
  expect(result.result.replyText).toBe("From the MCP host");
  expect(run).toHaveBeenCalledWith(context, {});
});
