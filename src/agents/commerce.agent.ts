// src/agents/commerce.agent.ts

import {
  generateText,
  stepCountIs,
  type LanguageModel,
} from "ai";

import { groq } from "../providers/groq.provider.js";
import { createSearchProductsTool } from "../tools/search-product.js";

import type {
  RecoveryAgentContext,
} from "./types.js";

export type CommerceAgentDependencies = {
  model?: LanguageModel;
  createSearchProductsTool?: typeof createSearchProductsTool;
};

export async function runCommerceAgent(
  context: RecoveryAgentContext,
  dependencies: CommerceAgentDependencies = {},
) {
  const model =
    dependencies.model ??
    groq("openai/gpt-oss-20b");

  const productToolFactory =
    dependencies.createSearchProductsTool ??
    createSearchProductsTool;

  const result = await generateText({
    model,

    system: buildSystemPrompt(context),

    messages: context.conversation.messages,

    tools: {
      searchProducts:
        productToolFactory(context.shop),
    },

    stopWhen: stepCountIs(5),
  });

  return {
    text: result.text,
  };
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

Previous conversation summary:
${conversation.summary ?? "No previous summary."}

CUSTOMER

First name: ${customer?.firstName ?? "unknown"}

BEHAVIOUR

Use the available tools whenever you need factual information
about products, prices, variants or availability.

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
sent through WhatsApp.
`.trim();
}