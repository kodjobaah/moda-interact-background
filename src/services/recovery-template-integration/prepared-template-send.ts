import type { SendTemplateInput } from "../../integration/whatsapp/types.js";
import type { PreparedRecoveryTemplate } from "../recovery-template-preparation/recovery-template.types.js";
import type { FinalTemplateIdentity } from "./final-template-registration.service.js";

export type RecoveryOfferPromise = Readonly<
  | { kind: "NO_OFFER" }
  | { kind: "CODE_OFFER" | "AUTOMATIC_OFFER"; providerDiscountId: string; code?: string }
>;

/** Translate ONLY transport shape, never compiled variable positions or URL
 * parameters. The Admin/BG001-frozen components are already authoritative. */
export function templateSendFields(
  prepared: PreparedRecoveryTemplate, recoveryPromise: RecoveryOfferPromise,
): Omit<SendTemplateInput, "to"> {
  if (prepared.outcome !== "prepared" ||
      prepared.template.name !== prepared.providerTemplateName ||
      prepared.template.language.code !== prepared.providerLanguageCode) {
    throw new Error("PREPARED_TEMPLATE_IDENTITY_INVALID");
  }
  let header: string | undefined;
  let image: string | undefined;
  let body: string[] | undefined;
  let button: { index: number; text: string } | undefined;
  let last = -1;
  for (const component of prepared.template.components) {
    const order = component.type === "header" ? 0 : component.type === "body" ? 1 : 2;
    if (order <= last) throw new Error("PREPARED_TEMPLATE_COMPONENT_ORDER_INVALID");
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
      button = { index, text: component.parameters[0].text };
    }
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
    ...(button ? { dynamicUrlButton: button } : {}),
    templateRegistration: registration,
    recoveryPromise,
  };
}
