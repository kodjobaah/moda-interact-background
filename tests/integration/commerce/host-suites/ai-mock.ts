import { describe, expect, it } from "vitest";
import { hostFixture as f } from "../host.fixture.js";

export function registerAiMockHostTests() {
  describe("ARCH-038 real SDK HTTP orchestration with local AI Mock", () => {
    it("sends two SDK requests with budgets, granted tools and the MCP result", async () => {
      const mock = new f.LLMock({ port: 0 });
      await mock.start();
      try {
        const url = new URL(mock.url);
        expect(url.protocol).toBe("http:");
        expect(["127.0.0.1", "localhost", "[::1]"]).toContain(url.hostname);
        f.aiMockRoute.baseURL = `${url.origin}/v1`;
        f.aiMockRoute.constructions.length = 0;

        const grantedTool = f.active.capabilities[0]!.toolDescriptor.name;
        const hasToolResult = (messages: Array<{ content: unknown }>) =>
          messages.some(
            (message) =>
              typeof message.content === "string" &&
              message.content.includes("Trusted commerce Tool result JSON"),
          );
        mock.on(
          {
            model: "moda/test-only",
            predicate: (req) => !hasToolResult(req.messages),
          },
          {
            toolCalls: [{ name: grantedTool, arguments: { handle: "linen" } }],
          },
        );
        mock.on(
          {
            model: "moda/test-only",
            predicate: (req) => hasToolResult(req.messages),
          },
          {
            toolCalls: [{ name: "finalResponse", arguments: f.exampleFinal }],
          },
        );

        const model = new f.OpenRouterModelClient({
          provider: "moda",
          providerModelId: "test-only",
          configurationSchemaVersion: 1,
          configuration: {},
          credential: "test-only-no-provider-key",
        });
        // Detect a missed Vitest constructor mock before any paid endpoint can
        // receive a request. Once confirmed, the SDK uses loopback HTTP only.
        expect(f.aiMockRoute.constructions).toEqual([
          {
            model: "moda/test-only",
            baseURL: `${url.origin}/v1`,
          },
        ]);

        await f.run(model.invoke.bind(model));
        const requests = mock
          .getRequests()
          .filter(
            (entry) =>
              entry.method === "POST" &&
              entry.path.endsWith("/chat/completions"),
          );
        expect(requests).toHaveLength(2);
        for (const request of requests) {
          expect(request.response.status).toBe(200);
          const body = request.body as {
            model: string;
            max_tokens: number;
            stream: boolean;
            messages: Array<{ role: string; content: unknown }>;
            tools: Array<{
              type: string;
              function: { name: string; parameters: unknown };
            }>;
          };
          expect(body.model).toBe("moda/test-only");
          expect(body.max_tokens).toBe(800);
          expect(body.stream).toBe(false);
          expect(body.tools.map((tool) => tool.function.name)).toEqual([
            grantedTool,
            "finalResponse",
          ]);
          expect(
            body.tools.every(
              (tool) =>
                tool.type === "function" &&
                tool.function.parameters !== undefined,
            ),
          ).toBe(true);
          expect(
            body.messages.some((message) => message.role === "system"),
          ).toBe(true);
        }
        expect(
          hasToolResult(
            (
              requests[0]!.body as {
                messages: Array<{ content: unknown }>;
              }
            ).messages,
          ),
        ).toBe(false);
        expect(
          hasToolResult(
            (
              requests[1]!.body as {
                messages: Array<{ content: unknown }>;
              }
            ).messages,
          ),
        ).toBe(true);
        const second = (
          requests[1]!.body as {
            messages: Array<{
              role: string;
              content: unknown;
              tool_call_id?: string;
              tool_calls?: Array<{
                id: string;
                function: { name: string; arguments: string };
              }>;
            }>;
          }
        ).messages;
        const assistantIndex = second.findIndex(
          (message) =>
            message.role === "assistant" && message.tool_calls?.length,
        );
        expect(assistantIndex).toBeGreaterThanOrEqual(0);
        const call = second[assistantIndex]!.tool_calls![0]!;
        expect(call.id).toBeTruthy();
        expect(call.function.name).toBe(grantedTool);
        expect(JSON.parse(call.function.arguments)).toEqual({
          handle: "linen",
        });
        const tool = second[assistantIndex + 1]!;
        expect(tool.role).toBe("tool");
        expect(tool.tool_call_id).toBe(call.id);
        expect(String(tool.content)).toContain(
          "Trusted commerce Tool result JSON",
        );
        expect(
          second.filter(
            (message) =>
              message.role === "user" &&
              String(message.content).includes(
                "Trusted commerce Tool result JSON",
              ),
          ),
        ).toHaveLength(0);
        expect(
          f.observations.filter((entry) => entry.method === "tools/call"),
        ).toHaveLength(1);
      } finally {
        f.aiMockRoute.baseURL = null;
        f.aiMockRoute.constructions.length = 0;
        await mock.stop();
      }
    });
  });
}
