import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { generateText } from "ai";

import { runCommerceAgent } from "../../../src/agents/commerce.agent.js";

import type { RecoveryAgentContext } from "../../../src/agents/types.js";

const { groq } = vi.hoisted(() => ({
  groq: vi.fn((modelId: string) => ({ modelId }) as any),
}));

vi.mock("../../../src/providers/groq.provider.js", () => ({
  groq,
}));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: vi.fn(),
}));

const context: RecoveryAgentContext = {
  shop: "test-shop.myshopify.com",
  recovery: {
    id: "recovery-1",
    status: "ENGAGED",
    checkoutToken: "checkout-token",
    completedAt: null,
    totalPrice: "24.95",
  },
  customer: null,
  conversation: {
    conversationId: "conversation-1",
    shop: "test-shop.myshopify.com",
    type: "RECOVERY",
    summary: null,
    version: 1,
    messages: [{ role: "user", content: "Hello" }],
  },
};

const originalModel = process.env.GROQ_COMMERCE_MODEL;

beforeEach(() => {
  vi.mocked(generateText).mockClear();
  vi.mocked(generateText).mockImplementation(async (options: any) => {
    await options.tools.finalResponse.execute({
      replyText: "Hello",
      detectedLanguageTag: null,
      detectedLanguageConfidence: null,
    });
    return {} as any;
  });
  groq.mockClear();
});

afterEach(() => {
  if (originalModel === undefined) {
    delete process.env.GROQ_COMMERCE_MODEL;
  } else {
    process.env.GROQ_COMMERCE_MODEL = originalModel;
  }
});

describe("CommerceAgent model configuration", () => {
  it("passes the configured model to the Groq provider", async () => {
    process.env.GROQ_COMMERCE_MODEL = "llama-3.3-70b-versatile";

    await expect(runCommerceAgent(context)).resolves.toMatchObject({
      replyText: "Hello",
    });

    expect(groq).toHaveBeenCalledWith("llama-3.3-70b-versatile");
    expect(vi.mocked(generateText)).toHaveBeenCalledOnce();
  });

  it.each([undefined, "", "   "])(
    "fails before provider use when GROQ_COMMERCE_MODEL is %j",
    async (model) => {
      if (model === undefined) {
        delete process.env.GROQ_COMMERCE_MODEL;
      } else {
        process.env.GROQ_COMMERCE_MODEL = model;
      }

      await expect(runCommerceAgent(context)).rejects.toMatchObject({
        name: "CommerceAgentConfigurationError",
        message: "GROQ_COMMERCE_MODEL environment variable is not set",
      });
      expect(groq).not.toHaveBeenCalled();
      expect(vi.mocked(generateText)).not.toHaveBeenCalled();
    },
  );
});