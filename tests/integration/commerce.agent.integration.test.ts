import "dotenv/config";

import {
  describe,
  expect,
  it,
} from "vitest";

import {
  tool,
} from "ai";

import {
  z,
} from "zod";

import {
  runCommerceAgent,
} from "../../src/agents/commerce.agent.fake.js";

import type {
  RecoveryAgentContext,
} from "../../src/agents/types.js";

const hasGroqKey =
  Boolean(process.env.GROQ_API_KEY);

const describeWithGroq =
  hasGroqKey
    ? describe
    : describe.skip;

describeWithGroq(
  "commerce agent integration",
  () => {
    it(
      "uses product search when the customer asks about products",
      async () => {
        const context: RecoveryAgentContext = {
          shop:
            "kwadwo-e4bf4mc4.myshopify.com",

          recovery: {
            id: "recovery-test-1",
            status: "ENGAGED",
            checkoutToken:
              "checkout-test-token",
            completedAt: null,
            totalPrice: "24.95",
          },

          customer: {
            id: "customer-test-1",
            phone: "+447700900000",
            firstName: "Kwadwo",
          },

          conversation: {
            conversationId: "conversation-test-1",
            shop: "kwadwo-e4bf4mc4.myshopify.com",
            type: "RECOVERY",
            summary: null,
            version: 1,

            messages: [
              {
                role: "assistant",
                content:
                  "You left something in your basket. Can I help?",
              },
              {
                role: "user",
                content:
                  "Do you have any ski wax?",
              },
            ],
          },
        };

        let searchCalled = false;
        let receivedQuery:
          | string
          | undefined;

        const fakeSearchProductsTool =
          () =>
            tool({
              description:
                "Search the Shopify store for products",

              inputSchema: z.object({
                query: z.string(),
              }),

              execute: async ({
                query,
              }) => {
                searchCalled = true;
                receivedQuery = query;

                return {
                  products: [
                    {
                      id: "gid://shopify/Product/10635855921445",
                      title:
                        "Selling Plans Ski Wax",
                      price: "24.95",
                      currency: "USD",
                      available: true,
                    },
                  ],
                };
              },
            });

        const result =
          await runCommerceAgent(
            context,
            {
              createSearchProductsTool:
                fakeSearchProductsTool as any,
            },
          );

        expect(searchCalled).toBe(true);

        expect(
          receivedQuery?.toLowerCase(),
        ).toContain("ski");

        expect(result.text).toBeTruthy();

        expect(
          result.text.toLowerCase(),
        ).toContain("ski");

        expect(
          result.text,
        ).toContain("24.95");
      },
      30_000,
    );
  },
);