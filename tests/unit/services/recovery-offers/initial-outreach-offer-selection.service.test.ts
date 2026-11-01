import { describe, expect, it, vi } from "vitest";
import { CommerceModelInvocationFailure } from "@modainteract/moda-interact-shared/commerce/runner";
import { CommerceHostError } from "../../../../src/commerce/mcp-client.js";
import { InitialOutreachOfferSelectionService } from
  "../../../../src/services/recovery-offers/initial-outreach-offer-selection.service.js";

describe("InitialOutreachOfferSelectionService", () => {
  it("builds BG010 input from the exact outreach attempt and returns its validated decision", async () => {
    const builtContext = { shopId: "shop-1", outreachAttemptId: "attempt-1" } as never;
    const agentResult = { kind: "NO_VERIFIED_OFFER", reason: "POLICY_NONE", discoveryIncomplete: false } as never;
    const signal = new AbortController().signal;
    const contextBuilder = { build: vi.fn(async () => builtContext) };
    const modelInvoker = vi.fn();
    const agent = vi.fn(async () => agentResult);
    const admissionToken = { shopId: "shop-1", checkoutRecoveryId: "recovery-1",
      outreachAttemptId: "attempt-1", generation: 1, fingerprint: "fingerprint",
      mode: "NONE", authorisedDiscountIds: [], priceReconciliation: null, sourceFence: null };
    const revalidator = { revalidateCurrentOutreachOffer: vi.fn(async () => ({
      kind: "NO_VERIFIED_OFFER" as const, result: agentResult, context: builtContext, admissionToken,
    })), validateAdmission: vi.fn(async () => true) };
    const service = new InitialOutreachOfferSelectionService({
      environment: "TEST" as never,
      contextBuilder: contextBuilder as never,
      modelInvoker: modelInvoker as never,
      agent: agent as never,
      revalidator: revalidator as never,
    });

    const result = await service.resolve({
      shopId: "shop-1",
      checkoutRecoveryId: "recovery-1",
      outreachAttemptId: "attempt-1",
      signal,
    });

    expect(contextBuilder.build).toHaveBeenCalledWith({
      shopId: "shop-1",
      checkoutRecoveryId: "recovery-1",
      outreachAttemptId: "attempt-1",
      signal,
    });
    expect(contextBuilder.build).toHaveBeenCalledTimes(2);
    expect(agent).toHaveBeenCalledWith(builtContext, expect.objectContaining({ signal, modelInvoker }));
    expect(revalidator.revalidateCurrentOutreachOffer).toHaveBeenCalledWith({
      shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
      proposed: agentResult, signal,
    });
    expect(result).toEqual({ result: agentResult, context: builtContext,
      currentContext: builtContext, signal, admissionToken });
  });

  it.each([
    ["retryable MCP unavailability", new CommerceHostError("UNAVAILABLE", true), "MCP_UNAVAILABLE"],
    ["typed model invocation failure", new CommerceModelInvocationFailure({
      stage: "model.invoke", reasonCode: "MODEL_INVOCATION_FAILED",
    }), "AI_UNAVAILABLE"],
  ] as const)("classifies only %s as optional enrichment", async (_label, failure, trigger) => {
    const builtContext = { shopId: "shop-1", outreachAttemptId: "attempt-1" } as never;
    const contextBuilder = { build: vi.fn(async () => builtContext) };
    const service = new InitialOutreachOfferSelectionService({
      environment: "TEST" as never,
      contextBuilder: contextBuilder as never,
      agent: vi.fn(async () => { throw failure; }) as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(service.resolve({ shopId: "shop-1", checkoutRecoveryId: "recovery-1",
      outreachAttemptId: "attempt-1" })).rejects.toMatchObject({
      name: "InitialOfferEnrichmentError", trigger, cause: failure,
    });
  });

  it.each([
    new Error("programming failure"),
    new CommerceHostError("DENIED", false),
    new CommerceHostError("CONFIGURATION", false),
  ])("propagates unclassified or mandatory agent failures unchanged", async (failure) => {
    const builtContext = { shopId: "shop-1", outreachAttemptId: "attempt-1" } as never;
    const contextBuilder = { build: vi.fn(async () => builtContext) };
    const service = new InitialOutreachOfferSelectionService({
      environment: "TEST" as never,
      contextBuilder: contextBuilder as never,
      agent: vi.fn(async () => { throw failure; }) as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(service.resolve({ shopId: "shop-1", checkoutRecoveryId: "recovery-1",
      outreachAttemptId: "attempt-1" })).rejects.toBe(failure);
  });
});
