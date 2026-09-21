import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalJson,
  CommerceEvidenceSchema,
  type CommerceToolResult,
} from "@modainteract/moda-interact-shared/commerce";
import { digest } from "../../../src/commerce/grants.js";
import {
  extractTrustedEvidence,
  TurnEvidenceRegistry,
} from "../../../src/commerce/evidence.js";

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
const evidence = (overrides: Record<string, unknown> = {}) => {
  const content = {
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
  };
  return { ...content, evidenceId: digest(canonicalJson(content)) };
};
const result = (data: unknown): CommerceToolResult => ({
  contractVersion: "commerce.v1",
  status: "OK",
  data,
  renderedText: "untrusted rendered offer text",
});

const canonicalFixture = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      "../../moda-interact-workspace-task-ARCH-020-BACKGROUND-002/docs/architecture/ARCH-020-evidence-contract-fixtures.json",
    ),
    "utf8",
  ),
) as {
  fixtureVersion: number;
  now: string;
  call: { name: string; arguments: Record<string, unknown> };
  original: { data: { alternatives: Array<{ evidence: unknown }> } };
};

describe("canonical C18 fixture", () => {
  it("loads the frozen seed and accepts its recomputed evidence digest", () => {
    expect(canonicalFixture.fixtureVersion).toBe(1);
    expect(canonicalFixture.now).toBe("2026-09-21T00:00:20.000Z");
    expect(canonicalFixture.call).toEqual({
      name: "find_basket_matches",
      arguments: { search: "accessory", limit: 1 },
    });
    const original = canonicalFixture.original.data.alternatives[0]?.evidence;
    expect(CommerceEvidenceSchema.safeParse(original).success).toBe(true);
    expect((original as { evidenceId: string }).evidenceId).toBe(
      digest(
        canonicalJson(
          Object.fromEntries(
            Object.entries(original as Record<string, unknown>).filter(
              ([key]) => key !== "evidenceId",
            ),
          ),
        ),
      ),
    );
  });
});

describe("turn-local offer evidence", () => {
  it("replays renamed evaluators with literal mapped arguments and does not trust renderedText", async () => {
    const registry = new TurnEvidenceRegistry();
    const original = evidence();
    registry.record(
      descriptor,
      { literal: "fixed", query: "linen" },
      result(original),
      extractTrustedEvidence,
    );
    const replay = vi.fn().mockResolvedValue(result(original));

    await expect(
      registry.refresh([original.evidenceId], {
        remoteCalls: 2,
        maxRemoteCalls: 10,
        now: () => Date.parse("2026-09-21T00:00:10.000Z"),
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        replay,
        extractEvidence: extractTrustedEvidence,
      }),
    ).resolves.toEqual({ kind: "accepted" });
    expect(replay).toHaveBeenCalledOnce();
    expect(replay.mock.calls[0]?.[0]).toMatchObject({
      name: descriptor.name,
      arguments: { literal: "fixed", query: "linen" },
    });
  });

  it("deduplicates duplicate evidence references and recommendation evidence without a separate evaluator", async () => {
    const registry = new TurnEvidenceRegistry();
    const original = evidence({
      proposal: {
        operations: [{ kind: "ADD", variantId: "variant-1", quantity: 1 }],
      },
    });
    registry.record(
      { ...descriptor, name: "recommendation_mapper" },
      { offerId: "offer-1", mappedLimit: 3 },
      result({
        alternatives: [
          {
            product: {
              productId: "product-1",
              variantId: "variant-1",
              title: "Linen",
              url: null,
              available: true,
              unitPrice: "100.00",
              currency: "GBP",
              productType: null,
              vendor: null,
              observedAt: "2026-09-21T00:00:00.000Z",
            },
            proposal: {
              operations: [{ kind: "ADD", variantId: "variant-1", quantity: 1 }],
            },
            extraSpend: "0.00",
            resultingTotal: "90.00",
            currency: "GBP",
            evidence: original,
            similarityReasons: [],
          },
        ],
        truncated: false,
      }),
      extractTrustedEvidence,
    );
    const replay = vi.fn().mockResolvedValue(result(original));

    await expect(
      registry.refresh([original.evidenceId, original.evidenceId], {
        remoteCalls: 1,
        maxRemoteCalls: 2,
        now: () => Date.parse("2026-09-21T00:00:10.000Z"),
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        replay,
        extractEvidence: extractTrustedEvidence,
      }),
    ).resolves.toEqual({ kind: "accepted" });
    expect(replay).toHaveBeenCalledOnce();
  });

  it("replays two distinct canonical recommendation alternatives once in reverse order", async () => {
    const first = canonicalFixture.original.data.alternatives[0]!.evidence as Record<string, unknown>;
    const { evidenceId: _firstEvidenceId, ...firstContent } = first;
    const secondContent = {
      ...firstContent,
      offerId: "offer-fixture-2",
      proposal: {
        operations: [{ kind: "ADD", variantId: "variant-fixture-2", quantity: 1 }],
      },
    };
    const second = {
      ...secondContent,
      evidenceId: digest(canonicalJson(secondContent)),
    };
    const registry = new TurnEvidenceRegistry();
    const recommendationResult = result({
      alternatives: [
        {
          ...(canonicalFixture.original.data.alternatives[0] as Record<string, unknown>),
          evidence: first,
        },
        {
          ...(canonicalFixture.original.data.alternatives[0] as Record<string, unknown>),
          product: {
            ...(canonicalFixture.original.data.alternatives[0]!.product as Record<string, unknown>),
            productId: "product-fixture-2",
            variantId: "variant-fixture-2",
          },
          proposal: second.proposal,
          evidence: second,
        },
      ],
      truncated: false,
    });
    registry.record(
      { ...descriptor, name: canonicalFixture.call.name },
      canonicalFixture.call.arguments,
      recommendationResult,
      extractTrustedEvidence,
    );
    const replay = vi.fn().mockResolvedValue(
      result({
        alternatives: [
          { ...(recommendationResult.data as any).alternatives[1] },
          { ...(recommendationResult.data as any).alternatives[0] },
        ],
        truncated: false,
      }),
    );

    await expect(
      registry.refresh([first.evidenceId as string, second.evidenceId], {
        remoteCalls: 0,
        maxRemoteCalls: 10,
        now: () => Date.parse(canonicalFixture.now),
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        replay,
        extractEvidence: extractTrustedEvidence,
      }),
    ).resolves.toEqual({ kind: "accepted" });
    expect(replay).toHaveBeenCalledOnce();
    expect(replay).toHaveBeenCalledWith({
      name: canonicalFixture.call.name,
      revision: `${descriptor.toolRevisionId}@${descriptor.definitionVersion}`,
      arguments: canonicalFixture.call.arguments,
    });
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
        extractEvidence: extractTrustedEvidence,
      }),
    ).resolves.toEqual({ kind: "refer" });
    expect(replay).not.toHaveBeenCalled();
  });

  it("fails closed when the evidence producer is revoked", async () => {
    const registry = new TurnEvidenceRegistry();
    const original = evidence();
    registry.record(descriptor, {}, result(original), extractTrustedEvidence);
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
        now: () => Date.parse("2026-09-21T00:00:20.000Z"),
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        replay,
        extractEvidence: extractTrustedEvidence,
      }),
    ).resolves.toEqual({ kind: "refer" });
    expect(replay).toHaveBeenCalledOnce();
  });

  it.each([
    ["basketFingerprint", "c".repeat(64)],
    ["ruleFingerprint", "d".repeat(64)],
    ["savings", "9.00"],
    ["resultingTotal", "80.00"],
    ["currency", "USD"],
    ["outcome", "DOES_NOT_QUALIFY"],
    [
      "proposal",
      { operations: [{ kind: "ADD", variantId: "variant-2", quantity: 1 }] },
    ],
  ])("rejects each independently changed recommendation field: %s", async (field, value) => {
    const registry = new TurnEvidenceRegistry();
    const original = evidence();
    registry.record(descriptor, {}, result(original), extractTrustedEvidence);
    const changed = vi.fn().mockResolvedValue(
      result(evidence({ [field]: value })),
    );
    await expect(
      registry.refresh([original.evidenceId], {
        remoteCalls: 0,
        maxRemoteCalls: 10,
        now: () => Date.parse("2026-09-21T00:00:10.000Z"),
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        replay: changed,
        extractEvidence: extractTrustedEvidence,
      }),
    ).resolves.toEqual({ kind: "refer" });
    expect(changed).toHaveBeenCalledOnce();
  });

  it("rejects exhausted refresh budget without replay", async () => {
    const registry = new TurnEvidenceRegistry();
    const original = evidence();
    registry.record(descriptor, {}, result(original), extractTrustedEvidence);

    const exhausted = vi.fn().mockResolvedValue(result(original));
    await expect(
      registry.refresh([original.evidenceId], {
        remoteCalls: 10,
        maxRemoteCalls: 10,
        now: () => Date.parse("2026-09-21T00:00:10.000Z"),
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        replay: exhausted,
        extractEvidence: extractTrustedEvidence,
      }),
    ).resolves.toEqual({ kind: "refer" });
    expect(exhausted).not.toHaveBeenCalled();
  });

  it("rechecks the lease before and after replay", async () => {
    const registry = new TurnEvidenceRegistry();
    const original = evidence();
    registry.record(descriptor, {}, result(original), extractTrustedEvidence);
    const assertCurrent = vi.fn().mockResolvedValue(undefined);
    await registry.refresh([original.evidenceId], {
      remoteCalls: 0,
      maxRemoteCalls: 10,
      now: () => Date.parse("2026-09-21T00:00:10.000Z"),
      assertCurrent,
      replay: vi.fn().mockResolvedValue(result(original)),
      extractEvidence: extractTrustedEvidence,
    });
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });

  it("rejects counterfeit digests and conflicting immutable provenance", async () => {
    const registry = new TurnEvidenceRegistry();
    const original = evidence();
    registry.record(
      descriptor,
      { query: "one" },
      result({ ...original, evidenceId: "c".repeat(64) }),
      extractTrustedEvidence,
    );
    registry.record(descriptor, { query: "one" }, result(original), extractTrustedEvidence);
    registry.record(descriptor, { query: "two" }, result(original), extractTrustedEvidence);
    const replay = vi.fn().mockResolvedValue(result(original));
    await expect(
      registry.refresh([original.evidenceId], {
        remoteCalls: 0,
        maxRemoteCalls: 10,
        now: () => Date.parse("2026-09-21T00:00:10.000Z"),
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        replay,
        extractEvidence: extractTrustedEvidence,
      }),
    ).resolves.toEqual({ kind: "refer" });
    expect(replay).not.toHaveBeenCalled();
  });

  it("does not resurrect expired original evidence or accept incomplete offers", async () => {
    const registry = new TurnEvidenceRegistry();
    const original = evidence({
      evaluatedAt: "2026-09-21T00:00:00.000Z",
      expiresAt: "2026-09-21T00:00:05.000Z",
    });
    registry.record(descriptor, {}, result(original), extractTrustedEvidence);
    const replay = vi.fn().mockResolvedValue(
      result(
        evidence({
          evaluatedAt: "2026-09-21T00:00:05.000Z",
          expiresAt: "2026-09-21T00:00:35.000Z",
        }),
      ),
    );
    await expect(
      registry.refresh([original.evidenceId], {
        remoteCalls: 0,
        maxRemoteCalls: 10,
        now: () => Date.parse("2026-09-21T00:00:05.001Z"),
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        replay,
        extractEvidence: extractTrustedEvidence,
      }),
    ).resolves.toEqual({ kind: "refer" });
    expect(replay).not.toHaveBeenCalled();

    const incomplete = new TurnEvidenceRegistry();
    const unusable = evidence({ savings: null, unresolvedConditions: [{ code: "x", description: "unknown" }] });
    incomplete.record(descriptor, {}, result(unusable), extractTrustedEvidence);
    await expect(
      incomplete.refresh([unusable.evidenceId], {
        remoteCalls: 0,
        maxRemoteCalls: 10,
        now: () => Date.parse("2026-09-21T00:00:01.000Z"),
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        replay: vi.fn().mockResolvedValue(result(unusable)),
        extractEvidence: extractTrustedEvidence,
      }),
    ).resolves.toEqual({ kind: "refer" });
  });

  it.each([
    ["missing", { alternatives: [], truncated: false }],
    ["empty", { alternatives: [], truncated: false }],
    ["truncated", { alternatives: [], truncated: true }],
    [
      "duplicate",
      {
        alternatives: [
          { product: null, proposal: null, extraSpend: null, resultingTotal: null, currency: null, evidence: evidence() },
          { product: null, proposal: null, extraSpend: null, resultingTotal: null, currency: null, evidence: evidence() },
        ],
        truncated: false,
      },
    ],
  ])("refers for an independent %s recommendation match", async (_name, data) => {
    const registry = new TurnEvidenceRegistry();
    const original = evidence();
    registry.record(descriptor, {}, result(original), extractTrustedEvidence);
    const replay = vi.fn().mockResolvedValue(result(data));
    await expect(
      registry.refresh([original.evidenceId], {
        remoteCalls: 0,
        maxRemoteCalls: 10,
        now: () => Date.parse("2026-09-21T00:00:10.000Z"),
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        replay,
        extractEvidence: extractTrustedEvidence,
      }),
    ).resolves.toEqual({ kind: "refer" });
    expect(replay).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "null money",
      {
        outcome: "UNKNOWN",
        savings: null,
        resultingTotal: null,
      },
    ],
    [
      "unresolved conditions",
      {
        outcome: "UNKNOWN",
        savings: null,
        resultingTotal: null,
        unresolvedConditions: [{ code: "UNKNOWN", description: "Needs checkout" }],
      },
    ],
  ])("keeps schema-valid %s out of positive eligibility", async (_name, overrides) => {
    const candidate = evidence(overrides);
    expect(CommerceEvidenceSchema.safeParse(candidate).success).toBe(true);
    const registry = new TurnEvidenceRegistry();
    registry.record(descriptor, {}, result(candidate), extractTrustedEvidence);
    const replay = vi.fn().mockResolvedValue(result(candidate));
    await expect(
      registry.refresh([candidate.evidenceId], {
        remoteCalls: 0,
        maxRemoteCalls: 10,
        now: () => Date.parse("2026-09-21T00:00:10.000Z"),
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        replay,
        extractEvidence: extractTrustedEvidence,
      }),
    ).resolves.toEqual({ kind: "refer" });
    expect(replay).toHaveBeenCalledOnce();
  });

  it("distinguishes stale and cancelled replay failures from referral failures", async () => {
    const original = evidence();
    for (const [failure, expected] of [
      [
        { contractVersion: "commerce.v1", status: "ERROR", code: "STALE_TURN", retryable: false },
        { kind: "suppress", reason: "STALE_TURN" },
      ],
      [new DOMException("cancelled", "AbortError"), { kind: "suppress", reason: "CANCELLED" }],
      [
        { contractVersion: "commerce.v1", status: "ERROR", code: "THROTTLED", retryable: true },
        { kind: "refer" },
      ],
    ] as const) {
      const registry = new TurnEvidenceRegistry();
      registry.record(descriptor, {}, result(original), extractTrustedEvidence);
      await expect(
        registry.refresh([original.evidenceId], {
          remoteCalls: 0,
          maxRemoteCalls: 10,
          now: () => Date.parse("2026-09-21T00:00:10.000Z"),
          assertCurrent: vi.fn().mockResolvedValue(undefined),
          replay: vi.fn().mockRejectedValue(failure),
          extractEvidence: extractTrustedEvidence,
        }),
      ).resolves.toEqual(expected);
    }
  });

  it.each([
    new DOMException("cancelled", "AbortError"),
    new Error("operator cancellation"),
    "operator cancellation",
  ])("suppresses every external cancellation reason: %s", async (failure) => {
    const registry = new TurnEvidenceRegistry();
    const original = evidence();
    registry.record(descriptor, {}, result(original), extractTrustedEvidence);
    await expect(
      registry.refresh([original.evidenceId], {
        remoteCalls: 0,
        maxRemoteCalls: 10,
        now: () => Date.parse("2026-09-21T00:00:10.000Z"),
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        isCancelled: () => true,
        replay: vi.fn().mockRejectedValue(failure),
        extractEvidence: extractTrustedEvidence,
      }),
    ).resolves.toEqual({ kind: "suppress", reason: "CANCELLED" });
  });

  it.each([
    "DENIED",
    "NOT_FOUND",
    "UNAVAILABLE",
    "THROTTLED",
    "INVALID_INPUT",
    "INCOMPATIBLE_VERSION",
  ] as const)("refers once for a resolved structured %s error", async (code) => {
    const registry = new TurnEvidenceRegistry();
    const original = evidence();
    registry.record(descriptor, {}, result(original), extractTrustedEvidence);
    const replay = vi.fn().mockResolvedValue({
      contractVersion: "commerce.v1",
      status: "ERROR",
      code,
      retryable: true,
    } satisfies CommerceToolResult);
    await expect(
      registry.refresh([original.evidenceId], {
        remoteCalls: 0,
        maxRemoteCalls: 10,
        now: () => Date.parse("2026-09-21T00:00:10.000Z"),
        assertCurrent: vi.fn().mockResolvedValue(undefined),
        replay,
        extractEvidence: extractTrustedEvidence,
      }),
    ).resolves.toEqual({ kind: "refer" });
    expect(replay).toHaveBeenCalledOnce();
  });

  it("extracts only strict evaluator and non-truncated recommendation evidence", () => {
    const original = evidence({
      proposal: {
        operations: [{ kind: "ADD", variantId: "variant-1", quantity: 1 }],
      },
    });
    expect(extractTrustedEvidence(result(original))).toEqual([original]);
    expect(
      extractTrustedEvidence(
        result({
          evidence: original,
          values: { description: "not an evidence result" },
        }),
      ),
    ).toEqual([]);
    expect(
      extractTrustedEvidence(result({ alternatives: [], truncated: true })),
    ).toEqual([]);
  });
});