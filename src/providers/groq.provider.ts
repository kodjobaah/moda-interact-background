import { createOpenAI as createGroq } from "@ai-sdk/openai";

const apiKey = process.env.GROQ_API_KEY;

if (!apiKey) {
  throw new Error(
    "GROQ_API_KEY environment variable is required",
  );
}

export const groq = createGroq({
  baseURL: "https://api.groq.com/openai/v1",
  apiKey,
});