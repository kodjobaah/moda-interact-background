import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/** Exercise the installed public export through its real LangChain message
 * assembly. Only the SDK constructor is intercepted; no provider can be called.
 */
function serializeAtModelBoundary(request: unknown) {
  const sdk = `
    export class OpenRouterError extends Error {}
    export class ChatOpenRouter {
      bindTools(tools, choice) {
        return { invoke: async (messages, options) => {
          globalThis.__chronologyBoundary = {
            messages: messages.map(message => ({ role: message._getType(), content: message.content })),
            toolNames: tools.map(tool => tool.function.name), choice,
            maxTokens: options.maxTokens, signalAborted: options.signal.aborted,
          };
          return { content: "Which snowboard would you like help with?", tool_calls: [], usage_metadata: { output_tokens: 9 } };
        } };
      }
    }
  `;
  const probe = spawnSync(process.execPath, ["--input-type=module"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 15000,
    env: { ...process.env, DATABASE_URL: "postgresql://unit:unit@127.0.0.1:1/unit", REDIS_URL: "redis://127.0.0.1:1" },
    input: `
      import { registerHooks } from "node:module";
      let networkCalls = 0;
      globalThis.fetch = async () => { networkCalls++; throw new Error("Provider network is forbidden in this regression"); };
      const stub = ${JSON.stringify(`data:text/javascript;base64,${Buffer.from(sdk).toString("base64")}`)};
      registerHooks({ resolve(specifier, context, nextResolve) {
        return specifier === "@langchain/openrouter" ? { url: stub, shortCircuit: true } : nextResolve(specifier, context);
      } });
      const { OpenRouterModelClient } = await import("@modainteract/moda-interact-shared/commerce/model/node");
      const client = new OpenRouterModelClient({ provider: "openai", providerModelId: "gpt-4.1-mini",
        configurationSchemaVersion: 1, configuration: { temperature: 0 }, credential: "unit-only-not-a-provider-key" });
      await client.invoke(${JSON.stringify(request)}, new AbortController().signal);
      console.log(JSON.stringify({ ...globalThis.__chronologyBoundary, networkCalls }));
    `,
  });
  expect(probe.error, probe.stderr).toBeUndefined();
  expect(probe.status, probe.stderr).toBe(0);
  return JSON.parse(probe.stdout.trim()) as {
    messages: Array<{ role: string; content: string }>;
    toolNames: string[]; maxTokens: number; signalAborted: boolean; networkCalls: number;
  };
}

const currentQuestion = "Can you tell me about snowboard?";
const previousFailure = "I cannot process that request right now. Please try again later.";
const base = {
  instructions: ["Help the customer using only granted tools."],
  context: { trustedRecovery: { currentMessages: [{ role: "user", content: currentQuestion }] } },
  messages: [],
  tools: [{ name: "finalResponse", description: "Respond to the current customer question", inputSchema: { type: "object", properties: {} } }],
  maxOutputTokens: 77,
};

describe("published Shared model chronology adoption", () => {
  it.each(["content", "text"] as const)("places old %s history before the current snowboard question at the SDK boundary", (field) => {
    const result = serializeAtModelBoundary({ ...base, history: [
      { role: "user", [field]: "Earlier question" }, { role: "assistant", [field]: previousFailure },
    ] });
    expect(result.messages.map(message => message.role)).toEqual(["system", "human", "ai", "human"]);
    expect(result.messages[1]?.content).toBe("Earlier question");
    expect(result.messages[2]?.content).toBe(previousFailure);
    expect(result.messages[3]?.content).toContain(currentQuestion);
    expect(result.toolNames).toEqual(["finalResponse"]);
    expect(result.maxTokens).toBe(77);
    expect(result.signalAborted).toBe(false);
    expect(result.networkCalls).toBe(0);
  });

  it("keeps current-turn tool observations after the current question", () => {
    const result = serializeAtModelBoundary({ ...base,
      history: [{ role: "assistant", content: previousFailure }],
      messages: [{ tool: "commerce_get_product", result: {
        contractVersion: "commerce.v1", status: "OK", data: { productId: "snowboard" }, renderedText: "Verified snowboard observation",
      } }],
    });
    expect(result.messages.map(message => message.role)).toEqual(["system", "ai", "human", "human"]);
    expect(result.messages[1]?.content).toBe(previousFailure);
    expect(result.messages[2]?.content).toContain(currentQuestion);
    expect(result.messages[3]?.content).toContain("commerce_get_product");
    expect(result.networkCalls).toBe(0);
  });
});
