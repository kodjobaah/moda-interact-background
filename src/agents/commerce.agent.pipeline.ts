import {
  Annotation,
  END,
  START,
  StateGraph,
} from "@langchain/langgraph";

import {
  runCommerceAgent,
  type CommerceAgentDependencies,
} from "./commerce.agent.js";

import type {
  RecoveryAgentContext,
} from "./types.js";

export const CommerceAgentState =
  Annotation.Root({
    context: Annotation<RecoveryAgentContext>(),
    result: Annotation<{ text: string }>(),
  });

export type CommerceAgentState =
  typeof CommerceAgentState.State;

export function createCommerceAgentPipeline(
  dependencies: CommerceAgentDependencies = {},
) {
  return new StateGraph(CommerceAgentState)
    .addNode("commerceAgent", async (state: CommerceAgentState) => ({
      result: await runCommerceAgent(
        state.context,
        dependencies,
      ),
    }))
    .addEdge(START, "commerceAgent")
    .addEdge("commerceAgent", END)
    .compile();
}
