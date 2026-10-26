import type { SendTemplateInput } from "../../integration/whatsapp/types.js";

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
  if (input.recoveryPromise && (!input.templateRegistration ||
      input.templateRegistration.purpose !== `INITIAL_${input.recoveryPromise.kind}` &&
      input.templateRegistration.purpose !== `FOLLOW_UP_${input.recoveryPromise.kind}`)) {
    throw new Error("automated_template_promise_mismatch");
  }
  const header = input.textHeader;
  if (header !== undefined && (typeof header !== "string" || header.length > 200 || !header.trim() || input.imageHeader)) {
    throw new Error("automated_template_invalid_header");
  }
  if (input.imageHeader && (!URL.canParse(input.imageHeader.link) ||
      new URL(input.imageHeader.link).protocol !== "https:")) {
    throw new Error("automated_template_invalid_media");
  }
  const button = input.dynamicUrlButton;
  if (button && (!Number.isSafeInteger(button.index) || button.index < 0 || typeof button.text !== "string")) {
    throw new Error("automated_template_invalid_button");
  }
  const providerInput: SendTemplateInput = {
    to: input.to,
    templateName: input.templateName,
    languageCode: input.languageCode,
    ...(input.bodyParameters !== undefined ? { bodyParameters } : {}),
    ...(header !== undefined ? { textHeader: header } : {}),
    ...(input.imageHeader ? { imageHeader: { link: input.imageHeader.link } } : {}),
    ...(button ? { dynamicUrlButton: { index: button.index, text: button.text } } : {}),
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
    dynamicUrlButton: button ? { index: button.index, text: button.text } : null,
  });
  if (Buffer.byteLength(effectiveText, "utf8") > 16_384) {
    throw new Error("automated_template_input_too_large");
  }
  return { effectiveText, providerInput };
}
