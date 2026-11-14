import { structuredFinalizationInstructions, RECOVERY_STRUCTURED_FINALIZATION_INSTRUCTION } from "../../../../src/commerce/structured-finalization-instructions.js";
import { PRODUCT_DISCOVERY_INSTRUCTION } from "../../../../src/commerce/product-discovery-instructions.js";
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
      expect(captured?.instructions).toContain(PRODUCT_DISCOVERY_INSTRUCTION);
      expect(platform).toBeGreaterThan(recovery);
      expect(shop).toBeGreaterThan(platform);
      expect(feature).toBeGreaterThan(shop);
      expect(instructions.match(/Platform business guidance\./g)).toHaveLength(1);
      expect(instructions.match(/Shop business guidance\./g)).toHaveLength(1);
    });
    it("adds pinned format guidance without forcing initial finalization or removing ordinary tools", async () => {
      f.active.responseContract.detailsSchema = { type: "object", properties: {
        productDetailSelections: { type: "array", maxItems: 3, items: { type: "object", properties: {
          productId: { type: "string", maxLength: 128 }, variantId: { type: ["string", "null"], maxLength: 128 },
        }, required: ["productId", "variantId"], additionalProperties: false } },
      }, required: [], additionalProperties: false };
      f.active.responseContractHash = f.digest(f.responseContractCanonicalJson(f.active.responseContract));
      const step = f.final(); const original = structuredClone(step); let captured: ModelRequest | undefined;
      const result = await f.run(async request => { captured = request; return step; });
      expect(captured?.requiredToolName).toBeUndefined();
      expect(captured?.tools.some(tool => tool.name !== "finalResponse")).toBe(true);
      for (const instruction of structuredFinalizationInstructions(f.active.responseContract)) {
        expect(captured?.instructions).toContain(instruction);
      }
      expect(captured?.instructions).toContain(RECOVERY_STRUCTURED_FINALIZATION_INSTRUCTION);
      expect(step).toEqual(original); expect(result.answerKind).toBe("REFER_TO_STORE");
    });
  });
}
