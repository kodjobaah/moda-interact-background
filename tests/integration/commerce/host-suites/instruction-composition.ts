import { describe, expect, it } from "vitest";
import type { ModelRequest } from "@modainteract/moda-interact-shared/commerce/runner";
import { hostFixture as f } from "../host.fixture.js";

export function registerInstructionCompositionTests() {
  describe("recommendation instruction composition", () => {
    it("places the published platform and shop prompts after recovery guidance", async () => {
      let captured: ModelRequest | undefined;
      await f.run(async (request) => { captured = request; return f.final(); });
      const instructions = captured?.instructions.join("\n") ?? "";
      const recovery = instructions.indexOf("The stored checkout total is historical, not current product pricing.");
      const platform = instructions.indexOf("Platform business guidance.");
      const shop = instructions.indexOf("Shop business guidance.");
      const feature = instructions.indexOf("Synthetic Feature behavior.");
      expect(recovery).toBeGreaterThanOrEqual(0);
      expect(platform).toBeGreaterThan(recovery);
      expect(shop).toBeGreaterThan(platform);
      expect(feature).toBeGreaterThan(shop);
      expect(instructions.match(/Platform business guidance\./g)).toHaveLength(1);
      expect(instructions.match(/Shop business guidance\./g)).toHaveLength(1);
    });
  });
}
