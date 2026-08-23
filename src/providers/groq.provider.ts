import { createGroq } from "@ai-sdk/groq";

const apiKey = process.env.GROQ_API_KEY;

if (!apiKey) {
  throw new Error("GROQ_API_KEY environment variable is not set");
}

export const groq = createGroq({
  apiKey,
});