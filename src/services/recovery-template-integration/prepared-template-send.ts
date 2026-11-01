import type { SendTemplateInput } from "../../integration/whatsapp/types.js";
import type { InitialOutreachCheckoutOfferSet } from "@modainteract/moda-interact-shared/commerce";
import type { PreparedRecoveryTemplate } from "../recovery-template-preparation/recovery-template.types.js";
import type { RecoveryPromotionTarget } from "../recovery-template-preparation/recovery-template.types.js";
import type { FinalTemplateIdentity } from "./final-template-registration.service.js";

export type RecoveryOfferPromise = Readonly<
  | { kind: "NO_OFFER" }
    | { kind: "CODE_OFFER"; promotionTarget: RecoveryPromotionTarget; providerDiscountId: string; code: string }
    | { kind: "AUTOMATIC_OFFER"; promotionTarget: RecoveryPromotionTarget; providerDiscountId: string }
    | { kind: "CHECKOUT_DISCOUNT"; promotionTarget: "CHECKOUT"; offerSet: InitialOutreachCheckoutOfferSet }
    | { kind: "ALTERNATIVE_PRODUCT_PROMOTION"; promotionTarget: "ALTERNATIVE_PRODUCT";
      offerId: string; providerDiscountId: string; method: "CODE"; code: string; productId: string;
      variantId: string | null; productTitle: string }
    | { kind: "ALTERNATIVE_PRODUCT_PROMOTION"; promotionTarget: "ALTERNATIVE_PRODUCT";
      offerId: string; providerDiscountId: string; method: "AUTOMATIC"; productId: string;
      variantId: string | null; productTitle: string }
>;

/** Translate ONLY transport shape, never compiled variable positions or URL
 * parameters. The Admin/BG001-frozen components are already authoritative. */
export function templateSendFields(
  prepared: PreparedRecoveryTemplate, recoveryPromise: RecoveryOfferPromise,
  promotionTarget: RecoveryPromotionTarget = "CHECKOUT",
): Omit<SendTemplateInput, "to"> {
  if (prepared.outcome !== "prepared" ||
      prepared.template.name !== prepared.providerTemplateName ||
      prepared.template.language.code !== prepared.providerLanguageCode) {
    throw new Error("PREPARED_TEMPLATE_IDENTITY_INVALID");
  }
  if (recoveryPromise.kind !== "NO_OFFER" && recoveryPromise.promotionTarget !== promotionTarget) {
    throw new Error("PREPARED_TEMPLATE_PROMOTION_TARGET_MISMATCH");
  }
  let header: string | undefined;
  let image: string | undefined;
  let body: string[] | undefined;
  const buttons: Array<{ index: number; text: string }> = [];
  let last = -1;
  for (const component of prepared.template.components) {
    const order = component.type === "header" ? 0 : component.type === "body" ? 1 : 2;
    if (order < last || (order === last && component.type !== "button")) {
      throw new Error("PREPARED_TEMPLATE_COMPONENT_ORDER_INVALID");
    }
    last = order;
    if (component.type === "header") {
      if (component.parameters.length !== 1) throw new Error("PREPARED_TEMPLATE_HEADER_INVALID");
      const parameter = component.parameters[0]!;
      if (parameter.type === "text") header = parameter.text;
      else image = parameter.image.link;
    } else if (component.type === "body") {
      body = component.parameters.map((parameter) => parameter.text);
    } else {
      const index = Number(component.index);
      if (!Number.isSafeInteger(index) || index < 0 || component.parameters.length !== 1 ||
          component.parameters[0]?.type !== "text") throw new Error("PREPARED_TEMPLATE_BUTTON_INVALID");
      buttons.push({ index, text: component.parameters[0].text });
    }
  }
  if (buttons.length > 2 || buttons.some((button, index) =>
      index > 0 && button.index <= buttons[index - 1]!.index) ||
      new Set(buttons.map(({ index }) => index)).size !== buttons.length) {
    throw new Error("PREPARED_TEMPLATE_BUTTON_INVALID");
  }
  const registration: FinalTemplateIdentity = {
    shopId: prepared.shopId, senderWabaId: prepared.senderWabaId,
    purpose: prepared.purpose, variantId: prepared.variantId,
    registrationId: prepared.registrationId, definitionId: prepared.definitionId,
    providerTemplateId: prepared.providerTemplateId,
    providerTemplateName: prepared.providerTemplateName,
    providerLanguageCode: prepared.providerLanguageCode,
    submittedContentHash: prepared.submittedContentHash,
    bindingFingerprint: prepared.bindingFingerprint,
  };
  return {
    templateName: prepared.providerTemplateName,
    languageCode: prepared.providerLanguageCode,
    ...(header !== undefined ? { textHeader: header } : {}),
    ...(image !== undefined ? { imageHeader: { link: image } } : {}),
    ...(body !== undefined ? { bodyParameters: body } : {}),
    ...(buttons.length === 1 ? { dynamicUrlButton: buttons[0] } : {}),
    ...(buttons.length > 1 ? { dynamicUrlButtons: buttons } : {}),
    templateRegistration: registration,
    recoveryPromise,
  };
}
