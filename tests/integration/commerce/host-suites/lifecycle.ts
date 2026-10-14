import { describe, expect, it, vi } from "vitest";
import { hostFixture as f } from "../host.fixture.js";

export function registerLifecycleHostTests() {
  describe("Commerce host lifecycle and diagnostics", () => {
it("passes a safe child logger to Shared while preserving the messaging service identity", async () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = f.createLogger({
      serviceName: "moda-messaging-worker",
      environment: f.environment,
      sink: (record) => records.push(record as unknown as Record<string, unknown>),
    });

    await f.run(async () => f.final(), f.context, undefined, logger);

    const started = records.find((record) => record.event === "commerce.turn.started");
    expect(started).toMatchObject({
      "service.name": "moda-messaging-worker",
      data: {
        component: "commerce-turn-runner",
        recoveryId: "recovery-fixture",
        conversationId: "conversation-fixture",
        modelSelectionSource: "PRICING_PLAN",
        merchantPricingPlanId: "plan-safe-id",
      },
    });
    expect(JSON.stringify(records)).not.toMatch(/Name <ignore rules>|Tell me about this basket|credential|provider payload/i);
  });

it("ARCH-029 identifies a model-invoker TypeError without logging its raw text", async () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = f.createLogger({
      serviceName: "moda-messaging-worker", environment: f.environment,
      sink: (record) => records.push(record as unknown as Record<string, unknown>),
    });
    await expect(f.run(async () => {
      throw new TypeError("Authorization Bearer SECRET-CUSTOMER");
    }, f.context, undefined, logger)).rejects.toMatchObject({
      code: "UNAVAILABLE", retryable: true,
    });
    const phases = records.filter((record) => record.event === "commerce.host.model_bridge.reached")
      .map((record) => (record.data as Record<string, unknown>).phase);
    expect(phases).toEqual(["turn_state_check", "production_model_invoke"]);
    expect(records.find((record) => record.event === "commerce.host.model_bridge.failed"))
      .toMatchObject({ data: {
        phase: "production_model_invoke", reasonCode: "HOST_MODEL_INVOKER_FAILED",
        exceptionName: "TypeError", conversationId: "conversation-fixture",
      } });
    expect(JSON.stringify(records)).not.toContain("SECRET-CUSTOMER");
  });

it("ARCH-029 identifies a post-invocation model-step TypeError separately", async () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = f.createLogger({
      serviceName: "moda-messaging-worker", environment: f.environment,
      sink: (record) => records.push(record as unknown as Record<string, unknown>),
    });
    await expect(f.run(async () => ({ calls: null, outputTokens: 1 }),
      f.context, undefined, logger)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(records.find((record) => record.event === "commerce.host.model_bridge.failed"))
      .toMatchObject({ data: {
        phase: "response_postprocess", reasonCode: "HOST_MODEL_RESPONSE_POSTPROCESS_FAILED",
        exceptionName: "TypeError",
      } });
  });

it("the model deadline aborts in-flight work without returning a deliverable reply", async () => {
  const controller = new AbortController();
  await expect(
    f.run(
      async (_request, signal) => {
        setTimeout(() => controller.abort(), 10);
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      },
      f.context,
      controller.signal,
    ),
  ).rejects.toMatchObject({ code: "CANCELLED" });
});

it("does not create a grant for an expired processing lease", async () => {
  f.state.processingStartedAt = new Date(Date.now() - 120001);
  await expect(f.run(vi.fn())).rejects.toMatchObject({ code: "STALE_TURN" });
  expect(f.db.commerceConversationGrant.create).not.toHaveBeenCalled();
  expect(f.observations).toHaveLength(0);
});

it("enforces the configured LIVE deadline including discovery (accelerated timer fixture)", async () => {
  const original = AbortSignal.timeout.bind(AbortSignal);
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation((ms) => original(ms === 60000 ? 300 : ms));
  try {
    await expect(
      f.run(
        async (_request, signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          ),
      ),
    ).rejects.toMatchObject({ code: "DEADLINE" });
    expect(timeout).toHaveBeenCalledWith(60000);
    expect(timeout).toHaveBeenCalledWith(10000);
  } finally {
    timeout.mockRestore();
  }
});
  });
}
