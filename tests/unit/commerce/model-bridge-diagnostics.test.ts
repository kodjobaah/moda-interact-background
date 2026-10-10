import { describe, expect, it, vi } from "vitest";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { CommerceModelInvocationFailure } from "@modainteract/moda-interact-shared/commerce/runner";
import {
  logCommerceModelBridgeMilestone,
  observeCommerceModelBridgePhase,
} from "../../../src/commerce/model-bridge-diagnostics.js";

const ids = {
  shopId: "safe-shop", recoveryId: "safe-recovery",
  conversationId: "safe-conversation", inboundVersion: 1,
};

function testLogger() {
  const debug = vi.fn();
  const error = vi.fn();
  return { logger: { debug, error } as unknown as StructuredLogger, debug, error };
}

describe("ARCH-029 model bridge diagnostics", () => {
  it.each([
    ["turn_state_check", "HOST_MODEL_TURN_STATE_CHECK_FAILED", /conversation state/],
    ["production_model_invoke", "HOST_MODEL_INVOKER_FAILED", /production-model invoker/],
    ["response_postprocess", "HOST_MODEL_RESPONSE_POSTPROCESS_FAILED", /returned model step/],
  ] as const)("identifies the exact %s phase without logging the raw exception", async (phase, reasonCode, message) => {
    const { logger, error } = testLogger();
    const original = new TypeError("Bearer private-key and customer conversation");
    await expect(observeCommerceModelBridgePhase(logger, ids, phase, async () => {
      throw original;
    })).rejects.toBe(original);
    expect(error).toHaveBeenCalledWith("commerce.host.model_bridge.failed", expect.objectContaining({
      ...ids, phase, reasonCode, reasonMessage: expect.stringMatching(message),
      exceptionName: "TypeError", operatorAction: expect.any(String),
    }));
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/private-key|customer conversation|Bearer/);
  });

  it("retains the safe, typed Shared model reason without leaking its original cause", async () => {
    const { logger, error } = testLogger();
    const original = new CommerceModelInvocationFailure({
      stage: "model.invoke", reasonCode: "PROVIDER_RATE_LIMITED", providerStage: "provider", statusCode: 429,
    }, new TypeError("Authorization: Bearer SECRET"));
    await expect(observeCommerceModelBridgePhase(logger, ids, "production_model_invoke", async () => {
      throw original;
    })).rejects.toBe(original);
    expect(error).toHaveBeenCalledWith("commerce.host.model_bridge.failed", expect.objectContaining({
      modelReasonCode: "PROVIDER_RATE_LIMITED", modelProviderStage: "provider",
      modelStatusCode: 429, exceptionName: "TypeError",
      modelReasonMessage: expect.any(String),
    }));
    expect(JSON.stringify(error.mock.calls)).not.toContain("SECRET");
  });

  it("emits a positive boundary milestone independently of the model result", () => {
    const { logger, debug } = testLogger();
    logCommerceModelBridgeMilestone(logger, ids, "turn_state_check");
    logCommerceModelBridgeMilestone(logger, ids, "production_model_invoke");
    expect(debug.mock.calls).toEqual([
      ["commerce.host.model_bridge.reached", { ...ids, phase: "turn_state_check" }],
      ["commerce.host.model_bridge.reached", { ...ids, phase: "production_model_invoke" }],
    ]);
  });

  it("does not alter successful results or replace a failure when logging sinks throw", async () => {
    const logger = {
      error: () => { throw new TypeError("sink error"); },
      debug: () => { throw new TypeError("sink error"); },
    } as unknown as StructuredLogger;
    logCommerceModelBridgeMilestone(logger, ids, "turn_state_check");
    await expect(observeCommerceModelBridgePhase(logger, ids, "turn_state_check", async () => 42))
      .resolves.toBe(42);
    const original = new Error("actual failure");
    await expect(observeCommerceModelBridgePhase(logger, ids, "production_model_invoke", async () => {
      throw original;
    })).rejects.toBe(original);
  });
});
