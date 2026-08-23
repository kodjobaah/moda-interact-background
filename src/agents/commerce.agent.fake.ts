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

type CommerceAgentDependencies = {
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

  console.log("Commerce agent result:", result);
  return {
    text: result.text,
    steps: result.steps,
  };
}

function buildSystemPrompt(
  context: RecoveryAgentContext,
) {
  const {
    recovery,
    customer,
    conversation,
  } = context;

  return `
You are a commerce assistant helping a Shopify customer.

Recovery status: ${recovery.status}
Checkout token: ${recovery.checkoutToken}
Checkout total: ${recovery.totalPrice ?? "unknown"}
Completed at: ${recovery.completedAt ?? "not completed"}

Conversation type: ${conversation.type}
Conversation summary: ${conversation.summary ?? "none"}

Customer first name: ${customer?.firstName ?? "unknown"}

Rules:
- If recovery status is COMPLETED, do not say the basket is abandoned.
- If recovery status is EXPIRED or CANCELLED, do not imply the old checkout is still active.
- Use Shopify tools for product, price and availability information.
- Never invent product information.
- Keep responses concise and suitable for WhatsApp.
`.trim();
}