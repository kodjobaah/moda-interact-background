import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  generateText,
} from "ai";

import {
  createCommerceAgentPipeline,
} from "../../src/agents/commerce.agent.pipeline.js";

import type {
  RecoveryAgentContext,
} from "../../src/agents/types.js";

vi.mock("../../src/providers/groq.provider.js", () => ({
  groq: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();

  return {
    ...actual,
    generateText: vi.fn(),
  };
});

describe("commerce agent LangGraph pipeline", () => {
  it("runs the agent node and mocked product tool without external calls", async () => {
    const context: RecoveryAgentContext = {
      shop: "test-shop.myshopify.com",
      recovery: {
        id: "recovery-1",
        status: "ENGAGED",
        checkoutToken: "checkout-token",
        completedAt: null,
        totalPrice: "24.95",
      },
      customer: {
        id: "customer-1",
        phone: "+447700900000",
        firstName: "Kwadwo",
      },
      conversation: {
        conversationId: "conversation-1",
        shop: "test-shop.myshopify.com",
        type: "PRODUCT_DISCOVERY",
        summary: null,
        version: 1,
        messages: [
          {
            role: "user",
            content: "Do you have ski wax?",
          },
        ],
      },
    };

    const model = {} as Parameters<typeof createCommerceAgentPipeline>[0]["model"];
    const searchProducts = vi.fn(async ({ query }: { query: string }) => ({
      products: [
        {
          id: "product-1",
          title: "Selling Plans Ski Wax",
          price: "24.95",
          currency: "USD",
          available: true,
          query,
        },
      ],
    }));
    const createSearchProductsTool = vi.fn(() => ({
      execute: searchProducts,
    }));

    vi.mocked(generateText).mockImplementation(async (options: any) => {
      const products = await options.tools.searchProducts.execute({
        query: "ski wax",
      });

      return {
        text: `${products.products[0].title} costs ${products.products[0].price}.`,
      } as any;
    });

    const pipeline = createCommerceAgentPipeline({
      model,
      createSearchProductsTool: createSearchProductsTool as any,
    });

    const result = await pipeline.invoke({ context });

    expect(result.result.text).toContain("Ski Wax");
    expect(result.result.text).toContain("24.95");
    expect(createSearchProductsTool).toHaveBeenCalledWith(
      "test-shop.myshopify.com",
    );
    expect(searchProducts).toHaveBeenCalledWith({
      query: "ski wax",
    });
    expect(generateText).toHaveBeenCalledOnce();
  });
});
