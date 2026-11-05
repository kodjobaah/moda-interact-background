import { describe, expect, it } from "vitest";
import { hostFixture as f } from "../host.fixture.js";

export function registerFallbackResponseTests() {
  describe("store fallback response", () => {
    it("uses the trusted Shop URL when no controlled product is retained", async () => {
      const result = await f.run(async () => f.final());
      expect(result.answerKind).toBe("REFER_TO_STORE");
      expect(result.replyText).toContain("https://fixture.myshopify.com");
      expect(result).not.toHaveProperty("hostComposedReplyCandidates");
    });
  });
}
