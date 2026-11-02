import { describe, expect, it } from "vitest";
import { prepareAutomatedTemplateInput } from "../../../../src/services/conversation-moderation/automated-template-input.js";

const base = { to: "15551234567", templateName: "checkout_recovery", languageCode: "en_US" };

describe("ARCH-040 automated template moderation input", () => {
  it("captures the exact dynamic parameters and stable template identity without recipient PII", () => {
    const input = { ...base, bodyParameters: ["Your saved cart", "Order 123"],
      dynamicUrlButton: { index: 0, text: "order-123" } };
    const result = prepareAutomatedTemplateInput(input);
    expect(JSON.parse(result.effectiveText)).toEqual({
      contract: "moda.whatsapp.automated-template-parameters.v1",
      templateName: "checkout_recovery", languageCode: "en_US",
      bodyParameters: ["Your saved cart", "Order 123"],
      textHeader: null,
      imageHeader: null,
      dynamicUrlButton: { index: 0, text: "order-123" },
    });
    expect(result.effectiveText).not.toContain(input.to);
    input.bodyParameters[0] = "changed after preparation";
    input.dynamicUrlButton.text = "different";
    expect(result.providerInput.bodyParameters).toEqual(["Your saved cart", "Order 123"]);
    expect(result.providerInput.dynamicUrlButton?.text).toBe("order-123");
  });

  it("changes moderation identity when template selection, language or any dynamic field changes", () => {
    const initial = prepareAutomatedTemplateInput({ ...base, bodyParameters: ["safe"] }).effectiveText;
    for (const modified of [
      { ...base, templateName: "other", bodyParameters: ["safe"] },
      { ...base, languageCode: "fr_FR", bodyParameters: ["safe"] },
      { ...base, bodyParameters: ["unsafe"] },
      { ...base, bodyParameters: ["safe"], dynamicUrlButton: { index: 0, text: "unsafe" } },
    ]) expect(prepareAutomatedTemplateInput(modified).effectiveText).not.toBe(initial);
  });

  it("supports already-approved static templates with no dynamic parameters", () => {
    const result = prepareAutomatedTemplateInput(base);
    expect(JSON.parse(result.effectiveText).bodyParameters).toEqual([]);
    expect(result.providerInput.bodyParameters).toBeUndefined();
  });

  it("snapshots two ordered URL button parameters without changing their indexes", () => {
    const result = prepareAutomatedTemplateInput({ ...base, dynamicUrlButtons: [
      { index: 0, text: "checkout-token" },
      { index: 1, text: "product-token" },
    ] });
    expect(result.providerInput.dynamicUrlButtons).toEqual([
      { index: 0, text: "checkout-token" },
      { index: 1, text: "product-token" },
    ]);
    expect(JSON.parse(result.effectiveText).dynamicUrlButtons).toEqual(result.providerInput.dynamicUrlButtons);
  });

  it("fails closed for unsupported image media and malformed/unbounded parameters", () => {
    expect(() => prepareAutomatedTemplateInput({ ...base, imageHeader: { link: "https://example.test/image" } }))
      .toThrow("automated_template_unsupported");
    expect(() => prepareAutomatedTemplateInput({ ...base, bodyParameters: ["x".repeat(17_000)] }))
      .toThrow("automated_template_input_too_large");
    expect(() => prepareAutomatedTemplateInput({ ...base, dynamicUrlButton: { index: -1, text: "unsafe" } }))
      .toThrow("automated_template_invalid_button");
  });
});
