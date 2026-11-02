import { describe, expect, it } from "vitest";
import { prepareAutomatedTemplateInput } from
  "../../../../src/services/conversation-moderation/automated-template-input.js";
import { templateSendFields } from
  "../../../../src/services/recovery-template-integration/prepared-template-send.js";
import type { PreparedRecoveryTemplate } from
  "../../../../src/services/recovery-template-preparation/recovery-template.types.js";

const hash = "a".repeat(64);
const base: PreparedRecoveryTemplate = {
  outcome: "prepared", shopId: "shop-1", senderWabaId: "waba-1",
  purpose: "INITIAL_NO_OFFER", canonicalLanguageTag: "en-GB", selectionSource: "exact",
  variantId: "variant-1", registrationId: "registration-1", definitionId: "definition-1",
  providerTemplateId: "meta-1", providerTemplateName: "moda_template",
  providerLanguageCode: "en_GB", submittedContentHash: hash, bindingFingerprint: hash,
  initialCheckoutItemsBodyPosition: 3,
  template: { name: "moda_template", language: { code: "en_GB" }, components: [
    { type: "header", parameters: [{ type: "text", text: "Store name" }] },
    { type: "body", parameters: [{ type: "text", text: "Alice" }, { type: "text", text: "Welcome" },
      { type: "text", text: "2 × Saved item" }] },
    { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "https%3A%2F%2Fshop.test" }] },
  ] },
};

describe("ARCH-047 compiled template component pass-through", () => {
  it("preserves frozen text-header, body order and checkout CTA parameters exactly", () => {
    const send = templateSendFields(base, { kind: "NO_OFFER" });
    expect(send).toMatchObject({
      templateName: "moda_template", languageCode: "en_GB", textHeader: "Store name",
      bodyParameters: ["Alice", "Welcome", "2 × Saved item"],
      dynamicUrlButton: { index: 0, text: "https%3A%2F%2Fshop.test" },
      templateRegistration: { shopId: "shop-1", variantId: "variant-1",
        registrationId: "registration-1", submittedContentHash: hash },
      recoveryPromise: { kind: "NO_OFFER" },
    });
    const emitted = prepareAutomatedTemplateInput({ ...send, to: "+447400123456" });
    expect(emitted.providerInput).toMatchObject({
      textHeader: "Store name", bodyParameters: ["Alice", "Welcome", "2 × Saved item"],
      dynamicUrlButton: { index: 0, text: "https%3A%2F%2Fshop.test" },
    });
    expect(emitted.providerInput).not.toHaveProperty("templateRegistration");
    expect(emitted.providerInput).not.toHaveProperty("recoveryPromise");
    expect(JSON.parse(emitted.effectiveText).recoveryPromise).toEqual({ kind: "NO_OFFER" });
  });

  it("preserves a READY media header without exporting its link to moderation text", () => {
    const image = { ...base, template: { ...base.template, components: [
      { type: "header", parameters: [{ type: "image", image: { link: "https://cdn.test/ready.jpg" } }] },
      { type: "body", parameters: [{ type: "text", text: "Alice" },
        { type: "text", text: "Welcome" }, { type: "text", text: "2 × Saved item" }] },
    ] } } as PreparedRecoveryTemplate;
    const send = templateSendFields(image, { kind: "NO_OFFER" });
    const emitted = prepareAutomatedTemplateInput({ ...send, to: "+447400123456" });
    expect(emitted.providerInput.imageHeader).toEqual({ link: "https://cdn.test/ready.jpg" });
    expect(emitted.effectiveText).not.toContain("https://cdn.test/ready.jpg");
    expect(JSON.parse(emitted.effectiveText).imageHeader).toBe("READY_DERIVATIVE");
  });

  it("preserves two approved URL button indexes through the durable moderation descriptor", () => {
    const prepared = { ...base, template: { ...base.template, components: [
      base.template.components[0]!, base.template.components[1]!,
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "checkout-token" }] },
      { type: "button", sub_type: "url", index: "1", parameters: [{ type: "text", text: "product-token" }] },
    ] } } as PreparedRecoveryTemplate;
    const send = templateSendFields(prepared, { kind: "NO_OFFER" });
    expect(send.dynamicUrlButtons).toEqual([
      { index: 0, text: "checkout-token" },
      { index: 1, text: "product-token" },
    ]);
    const emitted = prepareAutomatedTemplateInput({ ...send, to: "+447400123456" });
    expect(emitted.providerInput.dynamicUrlButtons).toEqual(send.dynamicUrlButtons);
    expect(JSON.parse(emitted.effectiveText).dynamicUrlButtons).toEqual(send.dynamicUrlButtons);
  });

  it("never accepts reordered compiled components, or a mismatched template promise", () => {
    const invalid = { ...base, template: { ...base.template,
      components: [base.template.components[1]!, base.template.components[0]!] } };
    expect(() => templateSendFields(invalid, { kind: "NO_OFFER" })).toThrow("COMPONENT_ORDER_INVALID");
    expect(() => prepareAutomatedTemplateInput({ ...templateSendFields(base, { kind: "NO_OFFER" }),
      to: "+447400123456", recoveryPromise: { kind: "CODE_OFFER", providerDiscountId: "coupon-1" } }))
      .toThrow("automated_template_promise_mismatch");
    expect(() => templateSendFields(base, {
      kind: "CODE_OFFER", promotionTarget: "CHECKOUT", providerDiscountId: "provider-1", code: "SAVE10",
    }, "ALTERNATIVE_PRODUCT")).toThrow("PREPARED_TEMPLATE_PROMOTION_TARGET_MISMATCH");
  });

  it("requires the verified initial summary position to point at nonempty body text", () => {
    expect(() => templateSendFields({ ...base, initialCheckoutItemsBodyPosition: null },
      { kind: "NO_OFFER" })).toThrow("INITIAL_CHECKOUT_ITEMS_POSITION_INVALID");
    expect(() => templateSendFields({ ...base, initialCheckoutItemsBodyPosition: 4 },
      { kind: "NO_OFFER" })).toThrow("INITIAL_CHECKOUT_ITEMS_BODY_INVALID");
    expect(() => templateSendFields({ ...base, template: { ...base.template,
      components: base.template.components.filter((component) => component.type !== "body") } },
    { kind: "NO_OFFER" })).toThrow("INITIAL_CHECKOUT_ITEMS_BODY_INVALID");
  });

  it("keeps FOLLOW_UP admission unchanged without an initial basket witness", () => {
    const followUp = { ...base, purpose: "FOLLOW_UP_NO_OFFER" as const,
      initialCheckoutItemsBodyPosition: null,
      template: { ...base.template, components: base.template.components.filter((component) =>
        component.type !== "body") } };
    expect(templateSendFields(followUp, { kind: "NO_OFFER" }).bodyParameters).toBeUndefined();
  });
});
