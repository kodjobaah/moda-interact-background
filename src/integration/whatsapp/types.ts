import type { FinalTemplateIdentity } from "../../services/recovery-template-integration/final-template-registration.service.js";
import type { RecoveryOfferPromise } from "../../services/recovery-template-integration/prepared-template-send.js";
import type { NormalizedWhatsAppInboundMessage } from "@modainteract/moda-interact-shared/whatsapp";

export type WhatsAppInboundEvent = NormalizedWhatsAppInboundMessage;

export interface SendMessageResult {
  providerMessageId: string;
}

export type WhatsAppSenderIdentity = Readonly<{
  providerAccountId: string;
  providerPhoneNumberId: string;
}>;

export interface SendImageInput {
  to: string;
  link: string;
  caption: string;
  replyToProviderMessageId?: string;
  /** Local frozen identity check; never included in the Meta request body. */
  expectedSender?: WhatsAppSenderIdentity;
}

export interface SendTextInput {
  to: string;
  text: string;
  previewUrl?: boolean;
  replyToProviderMessageId?: string;
  /** Local frozen identity check; never included in the Meta request body. */
  expectedSender?: WhatsAppSenderIdentity;
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
  /** Prepared frozen TEXT header, distinct from the READY image header. */
  textHeader?: string;
  /** BG001/BG006 identity: local permit input, never forwarded to Meta. */
  templateRegistration?: FinalTemplateIdentity;
  /** Durable record of the exact sequence-one promise, not sent to Meta. */
  recoveryPromise?: RecoveryOfferPromise;
  imageHeader?: WhatsAppTemplateImageHeader;
  dynamicUrlButton?: WhatsAppTemplateUrlButton;
  dynamicUrlButtons?: WhatsAppTemplateUrlButton[];
}
