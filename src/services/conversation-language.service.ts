import {
  canonicaliseLanguageTag,
  type InternationalContext,
} from "@modainteract/moda-interact-shared/internationalization";

export type InitialConversationLanguageInput = {
  currentLanguageTag: string | null;
  currentLanguageSource: InternationalContext["languageSource"];
  shopifyLanguageTag?: string | null;
  merchantLanguageTag?: string | null;
  platformLanguageTag?: string | null;
  explicitLanguageTag?: string | null;
};

export type ConversationLanguageResolution = {
  languageTag: string | null;
  languageSource: InternationalContext["languageSource"];
  changed: boolean;
};

export type DetectedLanguageInput = {
  recoveryConversation?: boolean;
  message: string;
  currentLanguageTag: string | null;
  currentLanguageSource: InternationalContext["languageSource"];
  detectedLanguageTag: string | null;
  detectedLanguageConfidence: number | null;
};

export type DetectedLanguageDecisionReason =
  | "accepted"
  | "customer-explicit"
  | "unstable-input"
  | "invalid-tag"
  | "invalid-confidence"
  | "low-confidence"
  | "same-base-language";

export type DetectedLanguageEvaluation = ConversationLanguageResolution & {
  reason: DetectedLanguageDecisionReason;
};

// Product rule: a detected language must be above 80% confidence.
const DETECTION_CONFIDENCE_THRESHOLD = 0.8;

function normalizeLanguageTag(value: string | null | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }

  try {
    return canonicaliseLanguageTag(value);
  } catch {
    return null;
  }
}

export function isStableLanguageSignal(message: string): boolean {
  const value = message.trim();
  if (!value || /^https?:\/\/\S+$/i.test(value) || /^[\d\s.,!?+\-()/#%]+$/.test(value)) {
    return false;
  }

  const words = value.match(/[\p{L}]+/gu) ?? [];
  return words.length >= 2 && words.join("").length >= 8;
}

/**
 * Conversation language policy only.
 *
 * The CommerceAgent turn is the single language detector for ordinary inbound
 * conversation traffic. This service resolves the initial/fallback language and
 * decides whether the model's bounded detection result is safe to persist.
 */
export class ConversationLanguageService {
  resolveInitialLanguage(
    input: InitialConversationLanguageInput,
  ): ConversationLanguageResolution {
    const currentLanguageTag = normalizeLanguageTag(input.currentLanguageTag);
    const explicitLanguageTag = normalizeLanguageTag(input.explicitLanguageTag);

    if (explicitLanguageTag) {
      return this.result(explicitLanguageTag, "customer-explicit", currentLanguageTag);
    }

    if (currentLanguageTag) {
      return this.result(
        currentLanguageTag,
        input.currentLanguageSource ?? null,
        currentLanguageTag,
      );
    }

    for (const candidate of [
      { languageTag: input.shopifyLanguageTag, source: "shopify" as const },
      { languageTag: input.merchantLanguageTag, source: "merchant-default" as const },
      { languageTag: input.platformLanguageTag, source: "platform-default" as const },
    ]) {
      const languageTag = normalizeLanguageTag(candidate.languageTag);
      if (languageTag) {
        return this.result(languageTag, candidate.source, currentLanguageTag);
      }
    }

    return this.result(null, null, currentLanguageTag);
  }

  evaluateDetectedLanguage(
    input: DetectedLanguageInput,
  ): DetectedLanguageEvaluation {
    const currentLanguageTag = normalizeLanguageTag(input.currentLanguageTag);
    const detectedLanguageTag = normalizeLanguageTag(input.detectedLanguageTag);

    if (!input.recoveryConversation && input.currentLanguageSource === "customer-explicit") {
      return {
        ...this.result(
          currentLanguageTag,
          input.currentLanguageSource,
          currentLanguageTag,
        ),
        reason: "customer-explicit",
      };
    }

    if (!isStableLanguageSignal(input.message)) {
      return {
        ...this.result(
          currentLanguageTag,
          input.currentLanguageSource ?? null,
          currentLanguageTag,
        ),
        reason: "unstable-input",
      };
    }

    if (!detectedLanguageTag) {
      return {
        ...this.result(
          currentLanguageTag,
          input.currentLanguageSource ?? null,
          currentLanguageTag,
        ),
        reason: "invalid-tag",
      };
    }

    if (
      typeof input.detectedLanguageConfidence !== "number" ||
      !Number.isFinite(input.detectedLanguageConfidence) ||
      input.detectedLanguageConfidence < 0 ||
      input.detectedLanguageConfidence > 1
    ) {
      return {
        ...this.result(
          currentLanguageTag,
          input.currentLanguageSource ?? null,
          currentLanguageTag,
        ),
        reason: "invalid-confidence",
      };
    }

    if (input.detectedLanguageConfidence <= DETECTION_CONFIDENCE_THRESHOLD) {
      return {
        ...this.result(
          currentLanguageTag,
          input.currentLanguageSource ?? null,
          currentLanguageTag,
        ),
        reason: "low-confidence",
      };
    }

    if (
      currentLanguageTag &&
      new Intl.Locale(currentLanguageTag).language ===
        new Intl.Locale(detectedLanguageTag).language
    ) {
      return {
        ...this.result(
          currentLanguageTag,
          input.currentLanguageSource ?? null,
          currentLanguageTag,
        ),
        reason: "same-base-language",
      };
    }

    return {
      ...this.result(detectedLanguageTag, "detected", currentLanguageTag),
      reason: "accepted",
    };
  }

  private result(
    languageTag: string | null,
    languageSource: InternationalContext["languageSource"],
    previousLanguageTag: string | null,
  ): ConversationLanguageResolution {
    return {
      languageTag,
      languageSource,
      changed: languageTag !== previousLanguageTag,
    };
  }
}

export const conversationLanguageService = new ConversationLanguageService();
