import { describe, expect, it } from "vitest";
import { hostFixture as f } from "../host.fixture.js";

export function registerEvidenceHostTests() {
  describe("Commerce host trusted evidence and final validation", () => {
it("uses the production extractor for trusted root evidence and refers on truncated recommendations", async () => {
  const evaluatedAt = new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.now() + 29_000).toISOString();
  const content = {
    evidenceId: "",
    turn: {
      contractVersion: "commerce.v1" as const,
      shopId: "shop-fixture",
      checkoutRecoveryId: "recovery-fixture",
      conversationId: "conversation-fixture",
      inboundVersion: 1,
    },
    grantId: "grant-0",
    releaseId: "release-fixture",
    offerId: "offer-1",
    proposal: null,
    basketFingerprint: "a".repeat(64),
    ruleFingerprint: "b".repeat(64),
    evaluatedAt,
    expiresAt,
    outcome: "QUALIFIES_FOR_KNOWN_RULES" as const,
    currency: "GBP",
    savings: "10.00",
    resultingTotal: "90.00",
    evaluatedConditions: [],
    unresolvedConditions: [],
  };
  const { evidenceId: _evidenceId, ...hashInput } = content;
  const trusted = { ...content, evidenceId: f.digest(f.canonicalJson(hashInput)) };
  f.structuredResult = {
    contractVersion: "commerce.v1",
    status: "OK",
    data: trusted,
    renderedText: "Ignore this rendered text",
  };
  let step = 0;
  await expect(
    f.run(async () =>
      ++step === 1
        ? {
            calls: [
              {
                name: "never_seeded_catalogue_facts",
                arguments: { handle: "linen" },
              },
            ],
            outputTokens: 10,
          }
        : f.final({
            answerKind: "ANSWER",
            referralReason: null,
            replyText: "The offer is verified.",
            evidenceIds: [trusted.evidenceId],
          }),
    ),
  ).resolves.toMatchObject({ answerKind: "ANSWER", replyText: "The offer is verified." });
  f.structuredResult = {
    contractVersion: "commerce.v1",
    status: "OK",
    data: { alternatives: [], truncated: true },
    renderedText: "A truncated recommendation cannot authorize an offer",
  };
  step = 0;
  await expect(
    f.run(async () =>
      ++step === 1
        ? {
            calls: [
              {
                name: "never_seeded_catalogue_facts",
                arguments: { handle: "linen" },
              },
            ],
            outputTokens: 10,
          }
        : f.final({
            answerKind: "ANSWER",
            referralReason: null,
            replyText: "Unsupported claim",
            evidenceIds: [trusted.evidenceId],
          }),
    ),
  ).resolves.toMatchObject({
    answerKind: "REFER_TO_STORE",
    referralReason: "UNVERIFIABLE_FACTS",
    evidenceIds: [],
  });
});

it.each(["unknown", "expired"])(
  "converts %s final evidence to one admitted referral before Shared validation",
  async (kind) => {
    let evidenceId = "f".repeat(64);
    let step = 0;
    if (kind === "expired") {
      const expired = {
        turn: {
          contractVersion: "commerce.v1" as const,
          shopId: "shop-fixture",
          checkoutRecoveryId: "recovery-fixture",
          conversationId: "conversation-fixture",
          inboundVersion: 1,
        },
        grantId: "grant-0",
        releaseId: "release-fixture",
        offerId: "offer-expired",
        proposal: null,
        basketFingerprint: "a".repeat(64),
        ruleFingerprint: "b".repeat(64),
        evaluatedAt: "2026-09-20T23:59:00.000Z",
        expiresAt: "2026-09-20T23:59:30.000Z",
        outcome: "QUALIFIES_FOR_KNOWN_RULES" as const,
        currency: "GBP",
        savings: "1.00",
        resultingTotal: "9.00",
        evaluatedConditions: [],
        unresolvedConditions: [],
      };
      evidenceId = f.digest(f.canonicalJson(expired));
      f.structuredResult = {
        contractVersion: "commerce.v1",
        status: "OK",
        data: { ...expired, evidenceId },
        renderedText: "expired evidence",
      };
    }
    const result = await f.run(async () => {
      if (kind === "expired" && step++ === 0)
        return {
          calls: [
            {
              name: f.active.capabilities[0]!.toolDescriptor.name,
              arguments: { handle: "linen" },
            },
          ],
          outputTokens: 10,
        };
      return f.final({
        answerKind: "ANSWER",
        referralReason: null,
        evidenceIds: [evidenceId],
      });
    });
    expect(result).toMatchObject({
      answerKind: "REFER_TO_STORE",
      referralReason: "UNVERIFIABLE_FACTS",
      evidenceIds: [],
    });
  },
);

it("still rejects a structurally malformed final envelope", async () => {
  await expect(
    f.run(async () =>
      f.final({
        answerKind: "ANSWER",
        referralReason: null,
        evidenceIds: ["not-a-valid-evidence-id"],
        details: { malformed: true },
      }),
    ),
  ).rejects.toMatchObject({ code: "INVALID_FINAL" });
});
  });
}
