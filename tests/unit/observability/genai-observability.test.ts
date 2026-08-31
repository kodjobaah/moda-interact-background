import { readFileSync } from "node:fs";

import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import {
  context as otelContext,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  generateText,
  type LanguageModel,
} from "ai";
import { observeConversationTurn } from "@modainteract/moda-interact-shared/observability/genai";

import { runCommerceAgent } from "../../../src/agents/commerce.agent.js";
import type { RecoveryAgentContext } from "../../../src/agents/types.js";
import { searchProducts } from "../../../src/services/shopify.service.js";

vi.mock("../../../src/providers/groq.provider.js", () => ({
  groq: vi.fn(),
}));

vi.mock("../../../src/services/shopify.service.js", () => ({
  searchProducts: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();

  return {
    ...actual,
    generateText: vi.fn(),
  };
});

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const contextManager = new AsyncHooksContextManager();

const agentContext: RecoveryAgentContext = {
  shop: "sensitive-shop.myshopify.com",
  recovery: {
    id: "recovery-secret-id",
    status: "ENGAGED",
    checkoutToken: "checkout-secret-token",
    completedAt: null,
    totalPrice: "24.95",
  },
  customer: {
    id: "customer-secret-id",
    phone: "+447700900000",
    firstName: "Sensitive Name",
  },
  conversation: {
    conversationId: "conversation-secret-id",
    shop: "sensitive-shop.myshopify.com",
    type: "PRODUCT_DISCOVERY",
    summary: "private summary",
    version: 1,
    messages: [{ role: "user", content: "private customer message" }],
  },
};

const turnObservation = {
  recordMetrics: false,
  mapException: () => ({
    name: "InboundTurnError",
    message: "Inbound conversation turn failed",
  }),
} as const;

beforeAll(() => {
  contextManager.enable();
  provider.register({ contextManager });
});

beforeEach(() => {
  exporter.reset();
  vi.clearAllMocks();
});

afterAll(async () => {
  contextManager.disable();
  await provider.shutdown();
});

async function runObservedTurn() {
  const workerSpan = provider
    .getTracer("background-genai-test")
    .startSpan("process whatsapp-events");

  try {
    return await otelContext.with(
      trace.setSpan(otelContext.active(), workerSpan),
      () => observeConversationTurn(
        "whatsapp",
        () => runCommerceAgent(agentContext, {
          model: {} as LanguageModel,
        }),
        turnObservation,
      ),
    );
  } finally {
    workerSpan.end();
    await provider.forceFlush();
  }
}

function serializeTelemetry(
  spans: ReturnType<typeof exporter.getFinishedSpans>,
) {
  return JSON.stringify(
    spans.map(({ name, attributes, status, events }) => ({
      name,
      attributes,
      status,
      events,
    })),
  );
}

describe.sequential("CommerceAgent GenAI observability", () => {
  it("nests one successful turn, agent and tool under the active Worker span", async () => {
    vi.mocked(searchProducts).mockResolvedValue([]);
    vi.mocked(generateText).mockImplementation(async (options: any) => {
      await options.tools.searchProducts.execute({ query: "boots" });
      return { text: "No matching products found." } as any;
    });

    await expect(runObservedTurn()).resolves.toEqual({
      text: "No matching products found.",
    });

    const spans = exporter.getFinishedSpans();
    const worker = spans.find((span) => span.name === "process whatsapp-events");
    const turn = spans.find((span) => span.name === "conversation.turn whatsapp");
    const agent = spans.find((span) => span.name === "invoke_agent commerce-agent");
    const tool = spans.find((span) => span.name === "execute_tool search-products");

    expect(worker).toBeDefined();
    expect(turn?.parentSpanContext?.spanId).toBe(worker?.spanContext().spanId);
    expect(agent?.parentSpanContext?.spanId).toBe(turn?.spanContext().spanId);
    expect(tool?.parentSpanContext?.spanId).toBe(agent?.spanContext().spanId);
    expect(turn?.status.code).toBe(SpanStatusCode.OK);
    expect(agent?.status.code).toBe(SpanStatusCode.OK);
    expect(tool?.status.code).toBe(SpanStatusCode.OK);
    expect(turn?.attributes).toEqual({ "moda.messaging.channel": "whatsapp" });
    expect(agent?.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "commerce-agent",
    });
    expect(tool?.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "search-products",
    });

    const telemetry = serializeTelemetry(spans);
    expect(telemetry).not.toMatch(
      /sensitive-shop|secret|private customer message|private summary|Sensitive Name|447700900000/i,
    );
  });

  it("records bounded safe exceptions and rethrows the original provider error", async () => {
    const providerError = new Error(
      "Shopify response contained bearer-secret and private customer message",
    );

    vi.mocked(searchProducts).mockRejectedValue(providerError);
    vi.mocked(generateText).mockImplementation(async (options: any) => {
      await options.tools.searchProducts.execute({ query: "boots" });
      return { text: "unreachable" } as any;
    });

    let thrown: unknown;
    try {
      await runObservedTurn();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(providerError);

    const spans = exporter.getFinishedSpans();
    const observed = spans.filter((span) =>
      [
        "conversation.turn whatsapp",
        "invoke_agent commerce-agent",
        "execute_tool search-products",
      ].includes(span.name),
    );

    expect(observed).toHaveLength(3);
    expect(observed.every((span) => span.status.code === SpanStatusCode.ERROR)).toBe(true);
    expect(
      observed.map((span) =>
        span.events.find((event) => event.name === "exception")
          ?.attributes?.["exception.message"],
      ),
    ).toEqual(expect.arrayContaining([
      "Inbound conversation turn failed",
      "Commerce agent invocation failed",
      "Shopify product search failed",
    ]));

    const telemetry = serializeTelemetry(observed);
    expect(telemetry).not.toMatch(/bearer-secret|private customer message|Shopify response contained/i);
  });

  it("activates shared metrics and configures safe exception mapping at every boundary", () => {
    const sources = [
      "src/workers/whatsapp.worker.ts",
      "src/agents/commerce.agent.ts",
      "src/tools/search-product.ts",
    ].map((path) => readFileSync(path, "utf8"));

    expect(sources[0]).toContain("observeConversationTurn(");
    expect(sources[1]).toContain("observeAgentInvocation(");
    expect(sources[2]).toContain("observeAgentTool(");
    for (const source of sources) {
      expect(source).not.toContain("recordMetrics: false");
      expect(source).toContain("mapException: () => ({");
      expect(source).not.toMatch(/createHistogram|createCounter|getMeter|moda\.agent\..*duration/);
    }
  });
});