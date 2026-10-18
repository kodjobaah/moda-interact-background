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
  if (!input.templateName?.trim() || !input.languageCode?.trim() || !input.to?.trim() || input.imageHeader) {
    throw new Error("automated_template_unsupported");
  }
  // Raw images are deliberately excluded from ARCH-040 text-only moderation.
  // Snapshot every dynamic value once, before any database or provider awaits.
  const bodyParameters = input.bodyParameters === undefined ? [] : [...input.bodyParameters];
  if (bodyParameters.length > 32 || bodyParameters.some((value) => typeof value !== "string")) {
    throw new Error("automated_template_invalid_parameters");
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
    ...(button ? { dynamicUrlButton: { index: button.index, text: button.text } } : {}),
  };
  const effectiveText = JSON.stringify({
    contract: "moda.whatsapp.automated-template-parameters.v1",
    templateName: providerInput.templateName,
    languageCode: providerInput.languageCode,
    bodyParameters,
    dynamicUrlButton: button ? { index: button.index, text: button.text } : null,
  });
  if (Buffer.byteLength(effectiveText, "utf8") > 16_384) {
    throw new Error("automated_template_input_too_large");
  }
  return { effectiveText, providerInput };
}
