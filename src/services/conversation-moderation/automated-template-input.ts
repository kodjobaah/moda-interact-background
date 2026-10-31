import type { SendTemplateInput } from "../../integration/whatsapp/types.js";
import type { RecoveryOfferPromise } from "../recovery-template-integration/prepared-template-send.js";

function promisedOfferPurpose(promise: RecoveryOfferPromise): "NO_OFFER" | "CODE_OFFER" | "AUTOMATIC_OFFER" | null {
  if (promise.kind === "NO_OFFER") return "NO_OFFER";
  if (promise.kind === "CODE_OFFER" || promise.kind === "AUTOMATIC_OFFER") return promise.kind;
  if (promise.kind === "ALTERNATIVE_PRODUCT_PROMOTION") {
    return promise.method === "CODE" ? "CODE_OFFER" : "AUTOMATIC_OFFER";
  }
  const methods = new Set(promise.offerSet.offers.map((offer) => offer.method));
  if (methods.size !== 1) return null;
  return methods.has("CODE") ? "CODE_OFFER" : "AUTOMATIC_OFFER";
}

/**
 * Moderation v1 can inspect the persisted template identity and dynamic text,
 * NOT the unseen provider-managed template body. The exact result is stored
 * as ConversationMessage.content and assessed under DATABASE-005 inputKind=TEXT.
 * This is a different contract from HUMAN_COMMAND TEMPLATE_PARAMETERS, which
 * has its own authoritative SQL renderer and persisted command columns.
 */
export function prepareAutomatedTemplateInput(input: SendTemplateInput): {
  effectiveText: string;
  providerInput: SendTemplateInput;
} {
  if (!input.templateName?.trim() || !input.languageCode?.trim() || !input.to?.trim() || (input.imageHeader && !input.templateRegistration) ||
      (input.textHeader && !input.templateRegistration)) {
    throw new Error("automated_template_unsupported");
  }
  // Raw images are deliberately excluded from ARCH-040 text-only moderation.
  // Snapshot every dynamic value once, before any database or provider awaits.
  const bodyParameters = input.bodyParameters === undefined ? [] : [...input.bodyParameters];
  if (bodyParameters.length > 32 || bodyParameters.some((value) => typeof value !== "string")) {
    throw new Error("automated_template_invalid_parameters");
  }
  if (input.recoveryPromise) {
    const offerPurpose = promisedOfferPurpose(input.recoveryPromise);
    if (!input.templateRegistration || !offerPurpose ||
        input.templateRegistration.purpose !== `INITIAL_${offerPurpose}` &&
        input.templateRegistration.purpose !== `FOLLOW_UP_${offerPurpose}`) {
      throw new Error("automated_template_promise_mismatch");
    }
  }
  const header = input.textHeader;
  if (header !== undefined && (typeof header !== "string" || header.length > 200 || !header.trim() || input.imageHeader)) {
    throw new Error("automated_template_invalid_header");
  }
  if (input.imageHeader && (!URL.canParse(input.imageHeader.link) ||
      new URL(input.imageHeader.link).protocol !== "https:")) {
    throw new Error("automated_template_invalid_media");
  }
  if (input.dynamicUrlButton && input.dynamicUrlButtons) {
    throw new Error("automated_template_invalid_button");
  }
  const buttons = input.dynamicUrlButtons ?? (input.dynamicUrlButton ? [input.dynamicUrlButton] : []);
  if (buttons.length > 2 || buttons.some(({ index, text }, buttonIndex) =>
      !Number.isSafeInteger(index) || index < 0 || typeof text !== "string" || !text.trim() ||
      (buttonIndex > 0 && index <= buttons[buttonIndex - 1]!.index)) ||
      new Set(buttons.map(({ index }) => index)).size !== buttons.length) {
    throw new Error("automated_template_invalid_button");
  }
  const dynamicUrlButtons = buttons.map(({ index, text }) => ({ index, text }));
  const providerInput: SendTemplateInput = {
    to: input.to,
    templateName: input.templateName,
    languageCode: input.languageCode,
    ...(input.bodyParameters !== undefined ? { bodyParameters } : {}),
    ...(header !== undefined ? { textHeader: header } : {}),
    ...(input.imageHeader ? { imageHeader: { link: input.imageHeader.link } } : {}),
    ...(input.dynamicUrlButtons ? { dynamicUrlButtons } :
      input.dynamicUrlButton && dynamicUrlButtons[0] ? { dynamicUrlButton: dynamicUrlButtons[0] } : {}),
  };
  const effectiveText = JSON.stringify({
    contract: "moda.whatsapp.automated-template-parameters.v1",
    templateName: providerInput.templateName,
    languageCode: providerInput.languageCode,
    bodyParameters,
    textHeader: header ?? null,
    // Only a READY derivative from BG001 may reach this branch. Keep signed
    // media URLs out of the moderation text and durable message body.
    imageHeader: input.imageHeader ? "READY_DERIVATIVE" : null,
    ...(input.recoveryPromise ? { recoveryPromise: input.recoveryPromise } : {}),
    dynamicUrlButton: input.dynamicUrlButton ? dynamicUrlButtons[0] : null,
    ...(input.dynamicUrlButtons ? { dynamicUrlButtons } : {}),
  });
  if (Buffer.byteLength(effectiveText, "utf8") > 16_384) {
    throw new Error("automated_template_input_too_large");
  }
  return { effectiveText, providerInput };
}
