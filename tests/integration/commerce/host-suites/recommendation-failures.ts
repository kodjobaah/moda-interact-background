import { describe, expect, it } from "vitest";
import { safeCommerceDiagnosticText } from "../../../../src/commerce/host-diagnostics.js";

export function registerRecommendationFailureTests() {
  describe("recommendation failure boundaries", () => {
    it("redacts an unsafe full diagnostic payload", () => {
      expect(safeCommerceDiagnosticText("SELECT * FROM customers WHERE email='private@example.test'"))
        .toMatchObject({ value: "[REDACTED]", redacted: true });
    });
  });
}
