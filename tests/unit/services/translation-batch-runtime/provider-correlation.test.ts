import { describe, expect, it } from "vitest";

import { routeTranslationBatchCorrelation } from "../../../../src/services/translation-batch-runtime/provider-correlation.js";

describe("translation batch provider correlation routing", () => {
  it("routes completed matches directly to results", () => {
    expect(routeTranslationBatchCorrelation("completed")).toBe("completed");
  });

  it.each(["nonterminal", "failed", "expired", "cancelled"] as const)(
    "routes correlated %s batches through canonical polling",
    (status) => {
      expect(routeTranslationBatchCorrelation(status)).toBe("poll");
    },
  );
});
