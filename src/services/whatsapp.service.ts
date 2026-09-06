import type {
  SendMessageResult,
  SendTemplateInput,
  SendTextInput,
} from "../integration/whatsapp/types.js";

export const DEFAULT_WHATSAPP_API_BASE_URL =
  "https://graph.facebook.com/v25.0";

type FetchImplementation = typeof fetch;

export type WhatsAppServiceErrorCode =
  | "configuration-missing"
  | "provider-rejected"
  | "invalid-provider-response";

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

  getProviderAccountId(): string {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!phoneNumberId) {
      throw new WhatsAppServiceError(
        "configuration-missing",
        "WhatsApp configuration is missing",
      );
    }
    return phoneNumberId;
  }

  async sendWhatsAppText({
    to,
    text,
  }: SendTextInput): Promise<SendMessageResult> {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

    const phoneNumberId = this.getProviderAccountId();
    if (!accessToken) {
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
      `${apiBaseUrl}/${phoneNumberId}/messages`,
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

          text: {
            body: text,
          },
        }),
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
  }: SendTemplateInput): Promise<SendMessageResult> {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = this.getProviderAccountId();
    if (!accessToken) {
      throw new WhatsAppServiceError(
        "configuration-missing",
        "WhatsApp configuration is missing",
      );
    }

    const apiBaseUrl = (
      process.env.WHATSAPP_API_BASE_URL?.trim() ||
      DEFAULT_WHATSAPP_API_BASE_URL
    ).replace(/\/+$/, "");

    const template = {
      name: templateName,
      language: { code: languageCode },
      ...(bodyParameters.length > 0
        ? {
            components: [
              {
                type: "body",
                parameters: bodyParameters.map((text) => ({
                  type: "text",
                  text,
                })),
              },
            ],
          }
        : {}),
    };

    const response = await this.fetchImplementation(
      `${apiBaseUrl}/${phoneNumberId}/messages`,
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
