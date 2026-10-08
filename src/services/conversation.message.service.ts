export class ConversationMessageService {
  buildRecoveryTemplateDescriptor({
    purpose,
    templateName,
    canonicalLanguageTag,
    providerLanguageCode,
  }: {
    purpose: string;
    templateName: string;
    canonicalLanguageTag: string;
    providerLanguageCode: string;
  }): string {
    return `[WhatsApp template sent; purpose=${purpose}; template=${templateName}; canonicalLanguage=${canonicalLanguageTag}; providerLanguage=${providerLanguageCode}]`;
  }
}

export const conversationMessageService =
  new ConversationMessageService();
