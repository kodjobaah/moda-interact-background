import { describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "@modainteract/moda-interact-shared/commerce/runner";
import { hostFixture as f } from "../host.fixture.js";

export function registerLiveBudgetHostTests() {
  describe("ARCH-038 LIVE host budget wiring", () => {
it("passes the pinned output-token limit to each model invocation", async () => {
    const invoke = vi.fn(async (request: ModelRequest) => {
      expect(request.maxOutputTokens).toBe(800);
      return f.final();
    });
    await f.run(invoke);
    expect(invoke).toHaveBeenCalled();
  });

it("resolves the current LIVE policy from PostgreSQL on every host invocation", async () => {
    let tokens = 1100;
    f.db.$transaction.mockImplementation(async (callback) => callback({
      subscription: { findUnique: async () => null },
      merchantPricingPlan: { findUnique: async () => { throw Error("inactive plan must not be read"); } },
      commerceModelPolicy: { findMany: async () => [{
        id: "platform-policy", scope: "PLATFORM", shopId: null, merchantPricingPlanId: null,
        budgetSchemaVersion: 1, budget: { deadlineMs: 60_000, outputTokens: tokens }, editVersion: 1,
      }] },
    }));
    const sentTokens: number[] = [];
    const invoke = vi.fn(async (request: ModelRequest) => {
      sentTokens.push(request.maxOutputTokens);
      return f.final();
    });
    // No test budget injected: this exercises the real host policy-resolution path.
    // Preserve the configured values: reducing them could hide a runner budget regression.
    const runPolicyBackedHost = async () => {
      try {
        await f.executeCommerceHost(f.context, { model: { invoke }, config: f.config() });
      } catch (error) {
        const failure = error as {
          code?: string;
          diagnostic?: {
            reasonCode?: string;
            runnerDiagnostic?: { stage?: string; reasonCode?: string };
          };
        };
        throw new Error([
          `host=${failure.code ?? "unknown"}`,
          `reason=${failure.diagnostic?.reasonCode ?? "unknown"}`,
          `runnerStage=${failure.diagnostic?.runnerDiagnostic?.stage ?? "unknown"}`,
          `runnerReason=${failure.diagnostic?.runnerDiagnostic?.reasonCode ?? "unknown"}`,
        ].join("; "), { cause: error });
      }
    };
    await runPolicyBackedHost();
    tokens = 1500;
    await runPolicyBackedHost();
    expect(sentTokens).toEqual([1100, 1500]);
    expect(f.db.$transaction).toHaveBeenCalledTimes(2);
  });

it("rejects another Shop's injected budget before contacting the model", async () => {
    const invoke = vi.fn(async () => f.final());
    await expect(f.executeCommerceHost(f.context, {
      model: { invoke }, config: f.config(),
      resolvedBudgetForTest: {
        shopId: "other-shop", conversationId: "conversation-fixture",
        recoveryId: "recovery-fixture", inboundVersion: 1,
        environment: f.environment, deadlineMs: 60_000, outputTokens: 800,
        deadlineSource: "PLATFORM", outputTokenSource: "PLATFORM",
        merchantPricingPlanId: null, shopifyPlanHandle: null,
        policyEditVersions: { platform: 1, pricePlan: null, merchant: null },
        resolvedAt: "2026-10-13T00:00:00.000Z",
      },
    })).rejects.toMatchObject({code:"UNAVAILABLE",retryable:false});
    expect(invoke).not.toHaveBeenCalled();
  });
  });
}
