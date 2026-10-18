import { describe, expect, it } from "vitest";
import { classifyModeration, moderationConfig } from "../../../../src/services/conversation-moderation/moderation-policy.js";
import { humanModerationAdmission } from "../../../../src/services/conversation-moderation/moderation-decision-adapter.js";

const safe = { flagged: false, categories: { harassment: false, "self-harm": false },
  categoryScores: { harassment: 0.02, "self-harm": 0.01 }, returnedModel: "omni-moderation-latest" };

describe("ARCH-040 moderation policy (no network)", () => {
  it("allows a valid nonflagged response without an arbitrary score threshold", () => {
    expect(classifyModeration(safe, "CUSTOMER_MESSAGE")).toEqual(expect.objectContaining({
      decision: "ALLOW", flagged: false, reasonCode: null,
    }));
  });
  it("blocks flagged HUMAN or AGENT with a bounded category reason", () => {
    const flagged = { ...safe, flagged: true, categories: { harassment: true }, categoryScores: { harassment: 0.93 } };
    expect(classifyModeration(flagged, "HUMAN_COMMAND")).toEqual(expect.objectContaining({
      decision: "BLOCK", reasonCode: "moderation_harassment",
    }));
    expect(classifyModeration(flagged, "AGENT_MESSAGE").decision).toBe("BLOCK");
    expect(humanModerationAdmission({ kind: "block", assessmentId: "a", reasonCode: "moderation_harassment" }))
      .toEqual({ kind: "blocked", failureCode: "HUMAN_CONTENT_MODERATION_BLOCKED" });
  });
  it("rejects absent results, incomplete categories and malformed scores, never ALLOW", () => {
    expect(() => classifyModeration({ ...safe, categories: {} }, "CUSTOMER_MESSAGE")).toThrow();
    expect(() => classifyModeration({ ...safe, flagged: true }, "HUMAN_COMMAND")).toThrow();
    expect(() => classifyModeration({ ...safe, categoryScores: { harassment: Number.NaN } }, "AGENT_MESSAGE")).toThrow();
    expect(() => classifyModeration({ ...safe, returnedModel: "" }, "AGENT_MESSAGE")).toThrow();
  });
  it("uses a fixed policy identity for audit and cache invalidation", () => {
    expect(moderationConfig().policyVersion).toBe("arch040-moderation-v1");
  });
  it("does not map transient/review statuses to a provider permit", () => {
    expect(humanModerationAdmission({ kind: "review_required", assessmentId: "a", reasonCode: "review" }).kind).toBe("blocked");
    expect(humanModerationAdmission({ kind: "retry", assessmentId: "a", retryAt: new Date() }).kind).toBe("retry");
  });
});
