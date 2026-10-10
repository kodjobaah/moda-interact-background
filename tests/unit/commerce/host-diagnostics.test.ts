import { describe, expect, it, vi } from "vitest";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { hostDiagnostic, logCommerceHostFailure, mcpTransportDiagnostic } from "../../../src/commerce/host-diagnostics.js";

const ids = {
  shopId: "shop-safe", recoveryId: "recovery-safe",
  conversationId: "conversation-safe", inboundVersion: 3,
};

describe("ARCH-029 Background host diagnostic safety", () => {
  it("explains HTTP 401 and 403 independently without raw provider text", () => {
    const unauthenticated = hostDiagnostic("mcp.authorization", "MCP_HTTP_UNAUTHENTICATED", {
      operation: "call_tool", statusCode: 401,
    });
    const forbidden = hostDiagnostic("mcp.authorization", "MCP_HTTP_FORBIDDEN", {
      operation: "call_tool", statusCode: 403,
    });
    expect(unauthenticated).toMatchObject({ statusCode: 401, reasonMessage: expect.stringContaining("401") });
    expect(forbidden).toMatchObject({ statusCode: 403, reasonMessage: expect.stringContaining("403") });
    expect(unauthenticated.reasonCode).not.toBe(forbidden.reasonCode);
  });

  it("retains only an allowlisted transport cause and bounded HTTP status", () => {
    const cause = Object.assign(new Error("Authorization: Bearer secret-customer-payload"), { code: "ENOTFOUND" });
    const failure = hostDiagnostic("mcp.connection", "MCP_TRANSPORT_FAILED", {
      operation: "initialize", statusCode: 999, cause: new Error("opaque", { cause }),
    });
    expect(failure).toMatchObject({ transportCode: "ENOTFOUND" });
    expect(failure).not.toHaveProperty("statusCode");
    expect(JSON.stringify(failure)).not.toContain("secret-customer-payload");
    expect(JSON.stringify(failure)).not.toContain("Bearer");
    const diagnosed = mcpTransportDiagnostic("mcp.connection", "initialize", cause);
    expect(diagnosed).toMatchObject({
      reasonCode: "MCP_DNS_HOST_NOT_FOUND",
      reasonMessage: expect.stringContaining("DNS"),
      transportCode: "ENOTFOUND",
    });
  });

  it("logs stable identifiers and Shared runner provenance without sensitive error text", () => {
    const error = vi.fn();
    const logger = { error, warn: vi.fn() } as unknown as StructuredLogger;
    const diagnostic = hostDiagnostic("mcp.tool_call", "MCP_HTTP_RATE_LIMITED", {
      statusCode: 429,
      operation: "call_tool",
      runnerDiagnostic: {
        stage: "tool.execute",
        reasonCode: "TOOL_EXECUTION_FAILED",
        reasonMessage: "Tool execution failed.",
        operatorAction: "Inspect the tool execution path.",
      },
    });
    logCommerceHostFailure(logger, "UNAVAILABLE", true, diagnostic, ids);
    expect(error).toHaveBeenCalledWith("commerce.host.failed", expect.objectContaining({
      ...ids, statusCode: 429, errorCode: "UNAVAILABLE", retryable: true,
      reasonCode: "MCP_HTTP_RATE_LIMITED", runnerStage: "tool.execute",
      runnerReasonCode: "TOOL_EXECUTION_FAILED",
    }));
  });

  it("does not replace the business failure when an injected logger throws", () => {
    const logger = {
      error: () => { throw new Error("logger sink leaked secret"); },
      warn: () => { throw new Error("logger sink leaked secret"); },
    } as unknown as StructuredLogger;
    expect(() => logCommerceHostFailure(logger, "DENIED", false,
      hostDiagnostic("host.authorization", "HOST_SHOP_ID_MISMATCH"), ids)).not.toThrow();
    expect(() => logCommerceHostFailure(logger, "UNAVAILABLE", true,
      hostDiagnostic("mcp.connection", "MCP_TRANSPORT_FAILED"), ids)).not.toThrow();
  });
});
