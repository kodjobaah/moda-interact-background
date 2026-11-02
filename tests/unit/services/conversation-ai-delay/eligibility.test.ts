import { describe, expect, it } from "vitest";
import { resolveEligibleAt } from "../../../../src/services/conversation-ai-delay/eligibility.js";

const pendingTurnStartedAt = new Date("2026-11-02T12:00:00.000Z");
const lastInboundAt = new Date("2026-11-02T12:02:00.000Z");

describe("resolveEligibleAt", () => {
  it.each([0, 1, 7, 30])("uses the frozen %i-minute AI deadline", (delayMinutes) => {
    const pendingAiNotBeforeAt = new Date(
      pendingTurnStartedAt.getTime() + delayMinutes * 60_000,
    );
    const settleDeadline = Math.min(
      lastInboundAt.getTime() + 3_000,
      pendingTurnStartedAt.getTime() + 10_000,
    );

    expect(resolveEligibleAt({
      pendingAiNotBeforeAt,
      lastInboundAt,
      pendingTurnStartedAt,
      quietMs: 3_000,
      maxMs: 10_000,
    })).toBe(Math.max(pendingAiNotBeforeAt.getTime(), settleDeadline));
  });

  it("keeps quiet settling for a standalone conversation with no merchant deadline", () => {
    expect(resolveEligibleAt({
      pendingAiNotBeforeAt: null,
      lastInboundAt,
      pendingTurnStartedAt,
      quietMs: 3_000,
      maxMs: 10_000,
    })).toBe(pendingTurnStartedAt.getTime() + 10_000);
  });

  it("caps quiet settling at the maximum window without shortening a frozen delay", () => {
    const pendingAiNotBeforeAt = new Date(pendingTurnStartedAt.getTime() + 5 * 60_000);
    const laterInbound = new Date(pendingTurnStartedAt.getTime() + 9 * 60_000);

    expect(resolveEligibleAt({
      pendingAiNotBeforeAt,
      lastInboundAt: laterInbound,
      pendingTurnStartedAt,
      quietMs: 3_000,
      maxMs: 10_000,
    })).toBe(pendingAiNotBeforeAt.getTime());
  });
});