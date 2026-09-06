// src/agents/commerce.agent.ts

import {
  generateText,
  hasToolCall,
  stepCountIs,
  tool,
  type LanguageModel,
} from "ai";
import { z } from "zod";
import { observeAgentInvocation } from "@modainteract/moda-interact-shared/observability/genai";

import { groq } from "../providers/groq.provider.js";
import { createSearchProductsTool } from "../tools/search-product.js";

import type {
  CommerceAgentResult,
  RecoveryAgentContext,
} from "./types.js";

const commerceAgentOutputSchema = z.object({
  replyText: z.string(),
  detectedLanguageTag: z.string().nullable(),
  detectedLanguageConfidence: z.number().min(0).max(1).nullable(),
});

export type CommerceAgentDependencies = {
  model?: LanguageModel;
  createSearchProductsTool?: typeof createSearchProductsTool;
};

export async function runCommerceAgent(
  context: RecoveryAgentContext,
  dependencies: CommerceAgentDependencies = {},
) {
  return observeAgentInvocation<CommerceAgentResult>(
    { agentName: "commerce-agent" },
    async () => {
      const model =
        dependencies.model ??
        groq("openai/gpt-oss-20b");

      const productToolFactory =
        dependencies.createSearchProductsTool ??
        createSearchProductsTool;

      let finalResponse: CommerceAgentResult | null = null;

      await generateText({
        model,

        system: buildSystemPrompt(context),

        messages: context.conversation.messages,

        tools: {
          searchProducts:
            productToolFactory(context.shop),
          finalResponse: tool({
            description:
              "Return the final customer reply and bounded language metadata.",
            inputSchema: commerceAgentOutputSchema,
            execute: async (input) => {
              finalResponse = input;
              return input;
            },
          }),
        },

        stopWhen: [
          hasToolCall("finalResponse"),
          stepCountIs(6),
        ],
        prepareStep: ({ steps }) => {
          const searchedProducts = steps.some((step) =>
            step.toolCalls.some((call) => call.toolName === "searchProducts"),
          );

          return searchedProducts
            ? {
                toolChoice: {
                  type: "tool",
                  toolName: "finalResponse",
                },
              }
            : {};
        },
      });

      if (!finalResponse) {
        throw new Error("Commerce agent did not produce a final response");
      }

      return finalResponse;
    },
    {
      mapException: () => ({
        name: "CommerceAgentError",
        message: "Commerce agent invocation failed",
      }),
    },
  );
}


function buildSystemPrompt(
  context: RecoveryAgentContext,
): string {
  const {
    recovery,
    customer,
    conversation,
  } = context;

  return `
You are an ecommerce assistant for a Shopify store.

Help customers with the checkout recovery they are discussing,
as well as product discovery and purchasing decisions.

CURRENT RECOVERY

Recovery status: ${recovery.status}
Checkout token: ${recovery.checkoutToken}
Checkout total: ${recovery.totalPrice ?? "unknown"}
Completed at: ${
    recovery.completedAt?.toISOString() ??
    "not completed"
  }

CONVERSATION

Conversation type: ${conversation.type}

Resolved customer language: ${conversation.languageTag ?? "unknown"}
Language source: ${conversation.languageSource ?? "unknown"}

Previous conversation summary:
${conversation.summary ?? "No previous summary."}

CUSTOMER

First name: ${customer?.firstName ?? "unknown"}

BEHAVIOUR

Use the available tools whenever you need factual information
about products, prices, variants or availability.

Always finish by calling the finalResponse tool exactly once. Its input must
contain the customer-facing reply and either both null detection fields or a
bounded language tag and confidence. Do not finish with ordinary assistant
text, and do not include reasoning in the finalResponse input.

Never invent products, prices, variants or availability.

The checkout recovery status is authoritative.

If the recovery status is COMPLETED:
- Do not tell the customer that their checkout is abandoned.
- Acknowledge that their purchase has already been completed
  when relevant.
- Continue helping with their current request normally.

If the recovery status is EXPIRED or CANCELLED:
- Do not imply that the original checkout is still active.
- Use Shopify tools when current product information is needed.

If the recovery status is MESSAGE_SENT or ENGAGED:
- Help the customer with the recovery and any product questions.

Keep responses concise and natural because they are being
sent through WhatsApp. Respond in the resolved customer language when one is
present. If the language source is customer-explicit, that preference governs
the reply and ordinary message-language detection must not switch it. Otherwise,
if the latest substantive customer message is clearly in another language,
answer in that language and report its narrowest defensible BCP-47 tag and
confidence in the finalResponse tool input. For ambiguous, short, emoji-only,
URL-only or numeric input, report null detection fields. Never invent a
regional subtag. Do not change prices, currency, URLs, order state or merchant
policy when adapting language.
`.trim();
}