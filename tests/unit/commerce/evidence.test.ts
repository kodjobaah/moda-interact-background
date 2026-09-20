import { describe, expect, it, vi } from "vitest";
import type { CommerceToolResult } from "@modainteract/moda-interact-shared/commerce";
import { TurnEvidenceRegistry } from "../../../src/commerce/evidence.js";

const turn = {
  contractVersion: "commerce.v1" as const,
  shopId: "shop-1",
  checkoutRecoveryId: "recovery-1",
  conversationId: "conversation-1",
  inboundVersion: 4,
};
const descriptor = {
  name: "renamed_offer_checker",
  toolRevisionId: "tool-revision-1",
  definitionVersion: "1.0.0",
};
const evidence = (overrides: Record<string, unknown> = {}) => ({
  evidenceId: "c".repeat(64),
  turn,
  grantId: "grant-1",
  releaseId: "release-1",
  offerId: "offer-1",
  proposal: null,
  basketFingerprint: "a".repeat(64),
  ruleFingerprint: "b".repeat(64),
  evaluatedAt: "2026-09-21T00:00:00.000Z",
  expiresAt: "2026-09-21T00:00:30.000Z",
  outcome: "QUALIFIES_FOR_KNOWN_RULES" as const,
  currency: "GBP",
  savings: "10.00",
  resultingTotal: "90.00",
  evaluatedConditions: [],
  unresolvedConditions: [],
  ...overrides,
});
const result = (data: unknown): CommerceToolResult => ({
  contractVersion: "commerce.v1",
  status: "OK",
  data,
  renderedText: "untrusted rendered offer text",
});
const extract = (value: CommerceToolResult) =>
  value.status === "OK" && value.data ? [value.data] : [];

describe("turn-local offer evidence", () => {
  it("replays renamed evaluators with literal mapped arguments and does not trust renderedText", async () => {
    const registry = new TurnEvidenceRegistry();
    const original = evidence();
    registry.record(descriptor, { literal: "fixed", query: "linen" }, result(original), extract);
    const replay = vi.fn().mockResolvedValue(result(original));

    await expect(
      registry.refresh([original.evidenceId], {
        remoteCalls: 2,
        maxRemoteCalls: 10,
        now: () => Date.parse("2026-09-21T00:00:10.000Z"),
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        replay,
        extractEvidence: extract,
      }),
    ).resolves.toBe(true);
    expect(replay).toHaveBeenCalledOnce();
    expect(replay.mock.calls[0]?.[0]).toMatchObject({
      name: descriptor.name,
      arguments: { literal: "fixed", query: "linen" },
    });
  });

  it("deduplicates duplicate evidence references and recommendation evidence without a separate evaluator", async () => {
    const registry = new TurnEvidenceRegistry();
    const original = evidence();
    registry.record(
      { ...descriptor, name: "recommendation_mapper" },
      { offerId: "offer-1", mappedLimit: 3 },
      result(original),
      extract,
    );
    const replay = vi.fn().mockResolvedValue(result(original));

    await expect(
      registry.refresh([original.evidenceId, original.evidenceId], {
        remoteCalls: 1,
        maxRemoteCalls: 2,
        now: () => Date.parse("2026-09-21T00:00:10.000Z"),
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        replay,
        extractEvidence: extract,
      }),
    ).resolves.toBe(true);
    expect(replay).toHaveBeenCalledOnce();
  });

  it("fails closed for missing provenance", async () => {
    const registry = new TurnEvidenceRegistry();
    const replay = vi.fn().mockResolvedValue({
      contractVersion: "commerce.v1",
      status: "ERROR",
      code: "DENIED",
      retryable: false,
    } satisfies CommerceToolResult);
    await expect(
      registry.refresh(["c".repeat(64)], {
        remoteCalls: 1,
        maxRemoteCalls: 10,
        now: Date.now,
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        replay,
        extractEvidence: extract,
      }),
    ).resolves.toBe(false);
    expect(replay).not.toHaveBeenCalled();
  });

  it("fails closed when the evidence producer is revoked", async () => {
    const registry = new TurnEvidenceRegistry();
    const original = evidence();
    registry.record(descriptor, {}, result(original), extract);
    const replay = vi.fn().mockResolvedValue({
      contractVersion: "commerce.v1",
      status: "ERROR",
      code: "DENIED",
      retryable: false,
    } satisfies CommerceToolResult);
    await expect(
      registry.refresh([original.evidenceId], {
        remoteCalls: 0,
        maxRemoteCalls: 10,
        now: Date.now,
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        replay,
        extractEvidence: extract,
      }),
    ).resolves.toBe(false);
  });

  it("rejects changed recommendations and exhausted refresh budget without replay", async () => {
    const registry = new TurnEvidenceRegistry();
    const original = evidence();
    registry.record(descriptor, {}, result(original), extract);
    const changed = vi.fn().mockResolvedValue(
      result(evidence({ resultingTotal: "80.00" })),
    );
    await expect(
      registry.refresh([original.evidenceId], {
        remoteCalls: 10,
        maxRemoteCalls: 10,
        now: () => Date.parse("2026-09-21T00:00:10.000Z"),
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        replay: changed,
        extractEvidence: extract,
      }),
    ).resolves.toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });

  it("rechecks the lease before and after replay", async () => {
    const registry = new TurnEvidenceRegistry();
    const original = evidence();
    registry.record(descriptor, {}, result(original), extract);
    const assertCurrent = vi.fn().mockResolvedValue(undefined);
    await registry.refresh([original.evidenceId], {
      remoteCalls: 0,
      maxRemoteCalls: 10,
      now: () => Date.parse("2026-09-21T00:00:10.000Z"),
      assertCurrent,
      replay: vi.fn().mockResolvedValue(result(original)),
      extractEvidence: extract,
    });
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });
});