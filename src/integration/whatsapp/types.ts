import type { NormalizedWhatsAppInboundMessage } from "@modainteract/moda-interact-shared/whatsapp";

export type WhatsAppMessageType =
  | "text"
  | "image"
  | "audio"
  | "document"
  | "interactive"
  | "unknown";

export type WhatsAppInboundEvent = NormalizedWhatsAppInboundMessage;

export interface SendMessageResult {
  providerMessageId: string;
}

export interface SendTextInput {
  to: string;
  text: string;
  previewUrl?: boolean;
  replyToProviderMessageId?: string;
}

export interface WhatsAppTemplateImageHeader {
  link: string;
}

export interface WhatsAppTemplateUrlButton {
  index: number;
  text: string;
}

export interface SendTemplateInput {
  to: string;
  templateName: string;
  languageCode: string;
  bodyParameters?: string[];
  imageHeader?: WhatsAppTemplateImageHeader;
  dynamicUrlButton?: WhatsAppTemplateUrlButton;
}