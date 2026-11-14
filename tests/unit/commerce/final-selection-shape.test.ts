import { describe, expect, it, vi } from "vitest";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { logFinalSelectionShape, projectFinalSelectionShape } from "../../../src/commerce/final-selection-shape.js";
const ids = { shopId: "shop", recoveryId: "recovery", conversationId: "conversation", inboundVersion: 1 };
describe("final selection shape", () => {
  it.each([undefined, null, "secret", [], 123])("bounds malformed containers %s", value => {
    expect(projectFinalSelectionShape(value)).toMatchObject({ answerKind: "ABSENT", recommendationCount: 0, unknownDetailKeyCount: 0 });
  });
  it("reports known arrays without inspecting their elements or leaking arbitrary values", () => {
    const secret = "PRIVATE_CUSTOMER_URL_TOKEN_PRODUCT";
    const details = { productRecommendations: Array(100).fill(secret), productDetailSelections: [], productOptionSelections: [secret], productRecommendationVersion: "1", responseDisposition: "PRODUCT_DETAILS", shippingInformationSelection: { productId: secret }, [secret]: secret };
    const shape = projectFinalSelectionShape({ answerKind: "ANSWER", replyText: secret, details });
    expect(shape).toMatchObject({ recommendationVersion: "V1", recommendationArray: "ARRAY", recommendationCount: 4, detailArray: "ARRAY", detailCount: 0, optionCount: 1, disposition: "PRODUCT_DETAILS", shippingSelectionContainer: "OBJECT", unknownDetailKeyCount: 1 });
    expect(JSON.stringify(shape)).not.toContain(secret);
  });
  it.each([null, "secret", 123, {}])("reports invalid selection fields %s", value => {
    expect(projectFinalSelectionShape({ answerKind: "secret", details: { productRecommendations: value, productRecommendationVersion: value, responseDisposition: value, shippingInformationSelection: value } })).toMatchObject({ answerKind: "INVALID", recommendationArray: "INVALID", recommendationVersion: "INVALID", disposition: "INVALID" });
  });
  it("caps unknown keys and never emits their names", () => {
    expect(projectFinalSelectionShape({ details: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`private${i}`, "secret"])) }).unknownDetailKeyCount).toBe(4);
  });
  it.each([[], [{ name: "other", arguments: "secret" }], Array(20).fill({ name: "finalResponse", arguments: "secret" })].map(calls => ({ calls })))("reports non-final or multiple calls without values", ({ calls }) => {
    const info = vi.fn(); const step = { calls, text: "secret" }; const before = structuredClone(step);
    logFinalSelectionShape({ info } as unknown as StructuredLogger, ids, step, false);
    expect(info.mock.calls[0]?.[1]).toMatchObject({ exactOneFinalResponse: false, callCount: Math.min(calls.length, 4), forcedFinalResponse: false });
    expect(step).toEqual(before); expect(JSON.stringify(info.mock.calls)).not.toContain("secret");
  });
  it("includes only independently pinned hex contract hashes", () => {
    const info = vi.fn(); const logger = { info } as unknown as StructuredLogger;
    logFinalSelectionShape(logger, ids, {}, false, "a".repeat(64));
    expect(info.mock.calls[0]?.[1]).toHaveProperty("responseContractHash", "a".repeat(64));
    logFinalSelectionShape(logger, ids, {}, false, "PRIVATE_SECRET");
    expect(info.mock.calls[1]?.[1]).not.toHaveProperty("responseContractHash");
    expect(JSON.stringify(info.mock.calls)).not.toContain("PRIVATE_SECRET");
  });
  it("keeps exact argument references/content and isolates getter and sink failures", () => {
    const args = { answerKind: "ANSWER", details: {} }; const call = { name: "finalResponse", arguments: args }; const step = { calls: [call] };
    const info = vi.fn(); logFinalSelectionShape({ info } as unknown as StructuredLogger, ids, step, true);
    expect(info.mock.calls[0]?.[1]).toMatchObject({ exactOneFinalResponse: true, detailsContainer: "OBJECT", recommendationArray: "ABSENT", forcedFinalResponse: true });
    expect(step.calls[0]).toBe(call); expect(call.arguments).toBe(args); expect(args).toEqual({ answerKind: "ANSWER", details: {} });
    expect(() => logFinalSelectionShape({ info() { throw new Error("secret"); } } as unknown as StructuredLogger, ids, step, true)).not.toThrow();
    expect(() => logFinalSelectionShape({ info } as unknown as StructuredLogger, ids, { get calls() { throw new Error("secret"); } }, false)).not.toThrow();
  });
});
