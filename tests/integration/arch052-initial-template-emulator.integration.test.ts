import { afterEach, describe, expect, it } from "vitest";
import type { PreparedMetaComponent, PreparedRecoveryTemplate } from "../../src/services/recovery-template-preparation/recovery-template.types.js";
import type { RecoveryOfferPromise } from "../../src/services/recovery-template-integration/prepared-template-send.js";
import { templateSendFields } from "../../src/services/recovery-template-integration/prepared-template-send.js";
import { prepareAutomatedTemplateInput } from "../../src/services/conversation-moderation/automated-template-input.js";
import { startArch040BackgroundMocks } from "./fixtures/arch040-background-mocks.fixture.js";

let harness: Awaited<ReturnType<typeof startArch040BackgroundMocks>> | undefined;

function preparedTemplate(
  name: string,
  purpose: PreparedRecoveryTemplate["purpose"],
  components: readonly PreparedMetaComponent[],
): PreparedRecoveryTemplate {
  return {
    outcome: "prepared", shopId: "shop-1", senderWabaId: "waba-1", purpose,
    variantId: `variant-${name}`, registrationId: `registration-${name}`,
    definitionId: `definition-${name}`, providerTemplateId: `provider-${name}`,
    providerTemplateName: name, providerLanguageCode: "en_GB", canonicalLanguageTag: "en",
    selectionSource: "exact", submittedContentHash: "a".repeat(64),
    bindingFingerprint: "a".repeat(64),
    initialCheckoutItemsBodyPosition: purpose.startsWith("INITIAL_") ? 2 : null,
    template: { name, language: { code: "en_GB" }, components },
  };
}

const cases: ReadonlyArray<Readonly<{
  name: string;
  prepared: PreparedRecoveryTemplate;
  promise: RecoveryOfferPromise;
  promotionTarget: "CHECKOUT" | "ALTERNATIVE_PRODUCT";
  expectedButtonIndexes: readonly string[];
}>> = [
  {
    name: "no-offer",
    prepared: preparedTemplate("arch052_no_offer", "INITIAL_NO_OFFER", [
      { type: "body", parameters: [{ type: "text", text: "Alex" },
        { type: "text", text: "2 × Shoes" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "checkout-suffix" }] },
    ]),
    promise: { kind: "NO_OFFER" },
    promotionTarget: "CHECKOUT",
    expectedButtonIndexes: ["0"],
  },
  {
    name: "checkout-code",
    prepared: preparedTemplate("arch052_checkout", "INITIAL_CODE_OFFER", [
      { type: "body", parameters: [{ type: "text", text: "Alex" },
        { type: "text", text: "2 × Shoes" }, { type: "text", text: "Example Shop" },
        { type: "text", text: "SAVE10" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "checkout-suffix" }] },
    ]),
    promise: { kind: "CHECKOUT_DISCOUNT", promotionTarget: "CHECKOUT",
      offerSet: { schemaVersion: "moda.outreach.checkout-offers.v1",
      offers: [{ offerId: "offer-1", providerDiscountId: "discount-1", method: "CODE", code: "SAVE10" }] } },
    promotionTarget: "CHECKOUT",
    expectedButtonIndexes: ["0"],
  },
  {
    name: "alternative-product",
    prepared: preparedTemplate("arch052_alternative", "INITIAL_CODE_OFFER", [
      { type: "body", parameters: [{ type: "text", text: "Alex" },
        { type: "text", text: "2 × Shoes" }, { type: "text", text: "Example Shop" },
        { type: "text", text: "Scarf" }, { type: "text", text: "SAVE10" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "checkout-suffix" }] },
      { type: "button", sub_type: "url", index: "1", parameters: [{ type: "text", text: "product-suffix" }] },
    ]),
    promise: { kind: "ALTERNATIVE_PRODUCT_PROMOTION", promotionTarget: "ALTERNATIVE_PRODUCT",
      offerId: "offer-1", providerDiscountId: "discount-1", method: "CODE", code: "SAVE10",
      productId: "product-1", variantId: "variant-1", productTitle: "Scarf" },
    promotionTarget: "ALTERNATIVE_PRODUCT",
    expectedButtonIndexes: ["0", "1"],
  },
];

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("ARCH-052 initial template Meta payloads", () => {
  it("sends no-offer, checkout, and alternative-product templates through the WhatsApp emulator", async () => {
    harness = await startArch040BackgroundMocks();

    for (const [index, item] of cases.entries()) {
      const fields = templateSendFields(item.prepared, item.promise, item.promotionTarget);
      const preparedInput = prepareAutomatedTemplateInput({
        ...fields, to: "+447400123456",
      });
      expect(JSON.parse(preparedInput.effectiveText).recoveryPromise).toEqual(item.promise);
      const { providerInput } = preparedInput;
      const sent = await harness.provider.sendWhatsAppTemplate(providerInput);
      expect(sent.providerMessageId).toBeTruthy();

      const messages = await harness.whatsapp.waitForMessageCount(index + 1);
      const body = messages[index]!.body;
      expect(body).toMatchObject({ type: "template", to: "+447400123456",
        template: { name: item.prepared.providerTemplateName, language: { code: "en_GB" } } });
      const buttons = body.template?.components?.filter((component) => component.type === "button") ?? [];
      expect(buttons.map((button) => button.index)).toEqual(item.expectedButtonIndexes);
      expect(buttons.every((button) => button.sub_type === "url" &&
        button.parameters?.length === 1 && button.parameters[0]?.type === "text")).toBe(true);
    }
  });
});
