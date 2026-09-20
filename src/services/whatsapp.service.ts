import type {
  SendMessageResult,
  SendTemplateInput,
  SendTextInput,
} from "../integration/whatsapp/types.js";

export const DEFAULT_WHATSAPP_API_BASE_URL =
  "https://graph.facebook.com/v25.0";
export const WHATSAPP_SEND_TIMEOUT_MS = 30_000;

type FetchImplementation = typeof fetch;

export type WhatsAppServiceErrorCode =
  | "configuration-missing"
  | "provider-rejected"
  | "invalid-provider-response";

export type ModaWhatsAppSender = {
  providerAccountId: string;
  providerPhoneNumberId: string;
};

export class WhatsAppServiceError extends Error {
  constructor(
    readonly code: WhatsAppServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WhatsAppServiceError";
  }
}

export class WhatsAppService {
  constructor(private readonly fetchImplementation: FetchImplementation = fetch) {}

  resolveSender(): ModaWhatsAppSender {
    const providerAccountId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID?.trim();
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!providerAccountId || !phoneNumberId?.trim()) {
      throw new WhatsAppServiceError(
        "configuration-missing",
        "WhatsApp configuration is missing",
      );
    }
    return { providerAccountId, providerPhoneNumberId: phoneNumberId.trim() };
  }

  getProviderAccountId(): string {
    return this.resolveSender().providerAccountId;
  }

  async sendWhatsAppText({
    to,
    text,
    previewUrl,
    replyToProviderMessageId,
  }: SendTextInput, signal?: AbortSignal): Promise<SendMessageResult> {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

    const sender = this.resolveSender();
    if (!accessToken?.trim()) {
      throw new WhatsAppServiceError(
        "configuration-missing",
        "WhatsApp configuration is missing",
      );
    }

    const apiBaseUrl = (
      process.env.WHATSAPP_API_BASE_URL?.trim() ||
      DEFAULT_WHATSAPP_API_BASE_URL
    ).replace(/\/+$/, "");

    const response = await this.fetchImplementation(
      `${apiBaseUrl}/${sender.providerPhoneNumberId}/messages`,
      {
        method: "POST",

        headers: {
          Authorization: `Bearer ${accessToken}`,

          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          messaging_product: "whatsapp",

          to,

          type: "text",

          ...(replyToProviderMessageId
            ? { context: { message_id: replyToProviderMessageId } }
            : {}),
          text: {
            body: text,
            ...(previewUrl ? { preview_url: true } : {}),
          },
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(WHATSAPP_SEND_TIMEOUT_MS)]) : AbortSignal.timeout(WHATSAPP_SEND_TIMEOUT_MS),
      },
    );

    const body = await response.json();

    if (!response.ok) {
      throw new WhatsAppServiceError("provider-rejected", "WhatsApp provider rejected the message");
    }

    const providerMessageId = body.messages?.[0]?.id;

    if (!providerMessageId) {
      throw new WhatsAppServiceError(
        "invalid-provider-response",
        "WhatsApp response did not contain a message id",
      );
    }

    return {
      providerMessageId,
    };
  }

  async sendWhatsAppTemplate({
    to,
    templateName,
    languageCode,
    bodyParameters = [],
    imageHeader,
    dynamicUrlButton,
  }: SendTemplateInput): Promise<SendMessageResult> {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const sender = this.resolveSender();
    if (!accessToken?.trim()) {
      throw new WhatsAppServiceError(
        "configuration-missing",
        "WhatsApp configuration is missing",
      );
    }

    const apiBaseUrl = (
      process.env.WHATSAPP_API_BASE_URL?.trim() ||
      DEFAULT_WHATSAPP_API_BASE_URL
    ).replace(/\/+$/, "");

    const components = [
      ...(imageHeader
        ? [{
            type: "header",
            parameters: [{ type: "image", image: { link: imageHeader.link } }],
          }]
        : []),
      ...(bodyParameters.length > 0
        ? [{
            type: "body",
            parameters: bodyParameters.map((text) => ({ type: "text", text })),
          }]
        : []),
      ...(dynamicUrlButton
        ? [{
            type: "button",
            sub_type: "url",
            index: String(dynamicUrlButton.index),
            parameters: [{ type: "text", text: dynamicUrlButton.text }],
          }]
        : []),
    ];
    const template = {
      name: templateName,
      language: { code: languageCode },
      ...(components.length > 0 ? { components } : {}),
    };

    const response = await this.fetchImplementation(
      `${apiBaseUrl}/${sender.providerPhoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "template",
          template,
        }),
        signal: AbortSignal.timeout(WHATSAPP_SEND_TIMEOUT_MS),
      },
    );

    const body = await response.json();
    if (!response.ok) {
      throw new WhatsAppServiceError(
        "provider-rejected",
        "WhatsApp provider rejected the template",
      );
    }

    const providerMessageId = body.messages?.[0]?.id;
    if (!providerMessageId) {
      throw new WhatsAppServiceError(
        "invalid-provider-response",
        "WhatsApp response did not contain a message id",
      );
    }

    return { providerMessageId };
  }
}

export const whatsAppService = new WhatsAppService();
