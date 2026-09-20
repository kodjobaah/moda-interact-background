import { observeAgentTool } from "@modainteract/moda-interact-shared/observability/genai";
// Fixed metric identity: authored names and tenant information are not labels.
export const observeCommerceTool = <T>(operation: () => Promise<T>) =>
  observeAgentTool("commerce-mcp", operation, {
    mapException: () => ({
      name: "CommerceToolError",
      message: "Commerce MCP tool failed",
    }),
  });
