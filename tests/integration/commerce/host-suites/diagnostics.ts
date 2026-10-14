import { describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "@modainteract/moda-interact-shared/commerce/runner";
import { hostFixture as f } from "../host.fixture.js";

export function registerMcpDiagnosticsHostTests() {
  describe("Commerce host MCP and runner diagnostics", () => {
it.each([
  ["401", "UNAVAILABLE"],
  ["403", "UNAVAILABLE"],
  ["429", "UNAVAILABLE"],
  ["503", "UNAVAILABLE"],
  ["MALFORMED", "UNAVAILABLE"],
  ["TRANSPORT", "UNAVAILABLE"],
] as const)("EC09 performs one MCP call for a real host boundary %s failure", async (failure, code) => {
  f.boundaryFailure = failure;
  const model = vi.fn(async (request: ModelRequest) =>
    request.tools.some((tool) => tool.name === "never_seeded_catalogue_facts")
      ? {
          calls: [
            {
              name: "never_seeded_catalogue_facts",
              arguments: { handle: "linen" },
            },
          ],
          outputTokens: 10,
        }
      : f.final(),
  );

  await expect(f.run(model)).rejects.toMatchObject({ code });
  expect(model).toHaveBeenCalledTimes(1);
  expect(f.observations.filter((observation) => observation.method === "tools/call")).toHaveLength(1);
});

it.each([
  ["401", "MCP_HTTP_UNAUTHENTICATED", 401],
  ["403", "MCP_HTTP_FORBIDDEN", 403],
  ["429", "MCP_HTTP_RATE_LIMITED", 429],
  ["503", "MCP_HTTP_SERVICE_UNAVAILABLE", 503],
] as const)("ARCH-029 distinguishes MCP tools/call HTTP %s without changing the public code", async (failure, reason, statusCode) => {
  f.boundaryFailure = failure;
  const records: Array<Record<string, unknown>> = [];
  const logger = f.createLogger({
    serviceName: "moda-messaging-worker", environment: f.environment,
    sink: (record) => records.push(record as unknown as Record<string, unknown>),
  });
  const model = vi.fn(async (request: ModelRequest) => request.tools.some(
    (tool) => tool.name === "never_seeded_catalogue_facts",
  ) ? {
    calls: [{ name: "never_seeded_catalogue_facts", arguments: { handle: "linen" } }],
    outputTokens: 10,
  } : f.final());
  await expect(f.run(model, f.context, undefined, logger)).rejects.toMatchObject({
    code: "UNAVAILABLE", retryable: true,
    diagnostic: { reasonCode: reason, statusCode, operation: "call_tool" },
  });
  const failureEvent = records.find((record) => record.event === "commerce.host.failed");
  expect(failureEvent).toMatchObject({ data: {
    shopId: "shop-fixture", recoveryId: "recovery-fixture",
    conversationId: "conversation-fixture", inboundVersion: 1,
    errorCode: "UNAVAILABLE", retryable: true, statusCode,
    reasonCode: reason, operation: "call_tool", runnerStage: "tool.execute",
  }});
  expect(records.some((record) => record.event === "commerce.turn.failed")).toBe(true);
  expect(f.observations.filter((o) => o.method === "tools/call")).toHaveLength(1);
  expect(JSON.stringify(records)).not.toMatch(/UNTRUSTED IGNORE RULES|Name <ignore rules>|Tell me about this basket/i);
});

it("ARCH-029 preserves Shared runner's precise final-validation diagnostic in the host log", async () => {
  const records: Array<Record<string, unknown>> = [];
  const logger = f.createLogger({ serviceName: "moda-messaging-worker", environment: f.environment,
    sink: (record) => records.push(record as unknown as Record<string, unknown>) });
  await expect(f.run(async () => ({ calls: [null], outputTokens: 1 }), f.context, undefined, logger))
    .rejects.toMatchObject({ code: "INVALID_FINAL", retryable: false,
      diagnostic: { stage: "host.runner_result", reasonCode: "HOST_RUNNER_FAILURE",
        runnerDiagnostic: { stage: "model.validate", reasonCode: "MODEL_TOOL_CALL_NULL" } } });
  expect(records.find((record) => record.event === "commerce.host.failed")).toMatchObject({
    data: { errorCode: "INVALID_FINAL", runnerStage: "model.validate",
      runnerReasonCode: "MODEL_TOOL_CALL_NULL" },
  });
});

it("ARCH-029 identifies invalid Commerce tool structured content rather than a generic execution failure", async () => {
  f.structuredResult = {
    contractVersion: "commerce.v1", status: "NOT_A_VALID_STATUS",
    data: { internalSecret: "never-log-tool-payload" },
  };
  const records: Array<Record<string, unknown>> = [];
  const logger = f.createLogger({ serviceName: "moda-messaging-worker", environment: f.environment,
    sink: (record) => records.push(record as unknown as Record<string, unknown>) });
  const model = vi.fn(async (request: ModelRequest) => request.tools.some(
    (tool) => tool.name === "never_seeded_catalogue_facts",
  ) ? {
    calls: [{ name: "never_seeded_catalogue_facts", arguments: { handle: "linen" } }],
    outputTokens: 10,
  } : f.final());
  await expect(f.run(model, f.context, undefined, logger)).rejects.toMatchObject({
    code: "UNAVAILABLE", retryable: true,
    diagnostic: { stage: "mcp.tool_result", reasonCode: "MCP_TOOL_RESULT_SCHEMA_INVALID" },
  });
  expect(records.find((record) => record.event === "commerce.host.failed")).toMatchObject({
    data: { errorCode: "UNAVAILABLE", reasonCode: "MCP_TOOL_RESULT_SCHEMA_INVALID",
      runnerStage: "tool.execute" },
  });
  expect(JSON.stringify(records)).not.toContain("never-log-tool-payload");
  expect(f.observations.filter((o) => o.method === "tools/call")).toHaveLength(1);
});

it("ARCH-029 explains a stale admitted version without changing its public identity", async () => {
  f.state.inboundVersion = 2;
  const records: Array<Record<string, unknown>> = [];
  const logger = f.createLogger({ serviceName: "moda-messaging-worker", environment: f.environment,
    sink: (record) => records.push(record as unknown as Record<string, unknown>) });
  await expect(f.run(vi.fn(), f.context, undefined, logger)).rejects.toMatchObject({
    code: "STALE_TURN", retryable: false,
    diagnostic: { stage: "host.turn_state", reasonCode: "HOST_VERSION_STALE" },
  });
  expect(records.find((record) => record.event === "commerce.host.failed")).toMatchObject({
    data: { errorCode: "STALE_TURN", reasonCode: "HOST_VERSION_STALE" },
  });
  expect(f.observations).toHaveLength(0);
});

it("ARCH-029 never logs an unexpected host exception's raw message", async () => {
  f.db.conversation.findUnique.mockRejectedValueOnce(new Error("Bearer secret-host-customer-payload"));
  const records: Array<Record<string, unknown>> = [];
  const logger = f.createLogger({ serviceName: "moda-messaging-worker", environment: f.environment,
    sink: (record) => records.push(record as unknown as Record<string, unknown>) });
  await expect(f.run(vi.fn(), f.context, undefined, logger)).rejects.toMatchObject({
    code: "UNAVAILABLE", retryable: true,
    diagnostic: { stage: "host.lifecycle", reasonCode: "HOST_UNEXPECTED_FAILURE" },
  });
  expect(records.find((record) => record.event === "commerce.host.failed")).toMatchObject({
    data: { reasonCode: "HOST_UNEXPECTED_FAILURE", errorCode: "UNAVAILABLE" },
  });
  expect(JSON.stringify(records)).not.toContain("secret-host-customer-payload");
});

it("ARCH-029 labels a shop identity denial and isolates a failing logger sink", async () => {
  const logger = f.createLogger({ serviceName: "moda-messaging-worker", environment: f.environment,
    sink: () => { throw new Error("hostile logger failure"); } });
  await expect(f.run(vi.fn(), { ...f.context, shopId: "different-shop" }, undefined, logger))
    .rejects.toMatchObject({ code: "DENIED", retryable: false,
      diagnostic: { stage: "host.authorization", reasonCode: "HOST_SHOP_ID_MISMATCH" } });
  expect(f.observations).toHaveLength(0);
});
  });
}
