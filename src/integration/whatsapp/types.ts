export type WhatsAppMessageType =
  | "text"
  | "image"
  | "audio"
  | "document"
  | "interactive"
  | "unknown";

export interface WhatsAppInboundEvent {
  provider: "whatsapp";

  /**
   * Meta's ID for this inbound message.
   */
  providerMessageId: string;

  /**
   * Customer's WhatsApp phone number.
   */
  customerPhone: string;

  /**
   * If the customer explicitly replied to one of our messages,
   * this is the Meta message ID of that original message.
   *
   * This is extremely important because:
   *
   * contextMessageId
   *   -> ConversationMessage
   *   -> Conversation
   *   -> CheckoutRecovery
   */
  contextMessageId: string | null;

  /**
   * Our WhatsApp Business phone-number ID.
   *
   * We may not need this for tenant routing because Moda owns
   * the WhatsApp account, but it is still useful provider metadata.
   */
  phoneNumberId: string;

  timestamp: number;

  type: WhatsAppMessageType;

  text: string | null;
}

export interface SendMessageResult {
  providerMessageId: string;
}

export interface SendTextInput {
  to: string;
  text: string;
}