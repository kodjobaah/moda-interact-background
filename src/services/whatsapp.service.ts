import type {
  SendMessageResult,
  SendTextInput,
} from "../integration/whatsapp/types.js";

export class WhatsAppService {
  async sendWhatsAppText({
    to,
    text,
  }: SendTextInput): Promise<SendMessageResult> {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

    if (!phoneNumberId || !accessToken) {
      throw new Error("WhatsApp configuration is missing");
    }

    const response = await fetch(
      `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
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
      throw new Error(`WhatsApp send failed: ${JSON.stringify(body)}`);
    }

    const providerMessageId = body.messages?.[0]?.id;

    if (!providerMessageId) {
      throw new Error("WhatsApp response did not contain a message id");
    }

    return {
      providerMessageId,
    };
  }
}

export const whatsAppService = new WhatsAppService();
