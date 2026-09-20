import { CommerceHostError } from "./mcp-client.js";
import { conversationLanguageService } from "../services/conversation-language.service.js";
import type {
  CommerceAgentResult,
  AgentConversationContext,
} from "../agents/types.js";
const referralText: Record<string, string> = {
  en: "Please contact the store directly for help with this question:",
  fr: "Veuillez contacter directement la boutique pour obtenir de l’aide sur cette question :",
  de: "Bitte wenden Sie sich bei dieser Frage direkt an den Shop:",
  es: "Contacta directamente con la tienda para obtener ayuda con esta pregunta:",
  it: "Contatta direttamente il negozio per ricevere assistenza su questa domanda:",
  pt: "Entre em contato diretamente com a loja para obter ajuda com esta pergunta:",
  nl: "Neem voor hulp bij deze vraag rechtstreeks contact op met de winkel:",
};
export function renderStoreReferral(
  domain: string,
  language: { tag: string | null; source: string | null },
  messages: AgentConversationContext["messages"],
  result: Omit<CommerceAgentResult, "replyText">,
) {
  // Shop.domain comes from the verified recovery owner, never from tool/model text.
  if (
    !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(domain)
  )
    throw new CommerceHostError("INVALID_INPUT");
  const resolved = conversationLanguageService.acceptDetectedLanguage({
    message: messages.map((m) => m.content).join("\n"),
    currentLanguageTag: language.tag,
    currentLanguageSource:
      language.source as AgentConversationContext["languageSource"],
    detectedLanguageTag: result.detectedLanguageTag,
    detectedLanguageConfidence: result.detectedLanguageConfidence,
  });
  const tag = resolved.languageTag?.split("-")[0] ?? "en";
  return `${referralText[tag] ?? referralText.en} https://${domain}`;
}
