import {
  canonicaliseLanguageTag,
  type InternationalContext,
} from "@modainteract/moda-interact-shared/internationalization";

export type LanguageDetectionResult = {
  languageTag: string;
  confidence: number;
};

export interface LanguageDetector {
  detect(message: string): LanguageDetectionResult | Promise<LanguageDetectionResult | null> | null;
}

export type ConversationLanguageInput = {
  message: string;
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
  message: string;
  currentLanguageTag: string | null;
  currentLanguageSource: InternationalContext["languageSource"];
  detectedLanguageTag: string | null;
  detectedLanguageConfidence: number | null;
};

const DETECTION_CONFIDENCE_THRESHOLD = 0.85;

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

function isStableLanguageSignal(message: string): boolean {
  const value = message.trim();
  if (!value || /^https?:\/\/\S+$/i.test(value) || /^[\d\s.,!?+\-()/#%]+$/.test(value)) {
    return false;
  }

  const words = value.match(/[\p{L}]+/gu) ?? [];
  return words.length >= 2 && words.join("").length >= 8;
}

export function defaultLanguageDetector(): null {
  return null;
}

export class ConversationLanguageService {
  constructor(
    private readonly detector: LanguageDetector = {
      detect: defaultLanguageDetector,
    },
  ) {}

  async resolveInitial(
    input: Omit<ConversationLanguageInput, "message">,
  ): Promise<ConversationLanguageResolution> {
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

  acceptDetectedLanguage(
    input: DetectedLanguageInput,
  ): ConversationLanguageResolution {
    const currentLanguageTag = normalizeLanguageTag(input.currentLanguageTag);
    const detectedLanguageTag = normalizeLanguageTag(input.detectedLanguageTag);

    if (input.currentLanguageSource === "customer-explicit") {
      return this.result(
        currentLanguageTag,
        input.currentLanguageSource,
        currentLanguageTag,
      );
    }

    if (
      !isStableLanguageSignal(input.message) ||
      !detectedLanguageTag ||
      typeof input.detectedLanguageConfidence !== "number" ||
      input.detectedLanguageConfidence < DETECTION_CONFIDENCE_THRESHOLD ||
      input.detectedLanguageConfidence > 1
    ) {
      return this.result(
        currentLanguageTag,
        input.currentLanguageSource ?? null,
        currentLanguageTag,
      );
    }

    if (
      currentLanguageTag &&
      new Intl.Locale(currentLanguageTag).language ===
        new Intl.Locale(detectedLanguageTag).language
    ) {
      return this.result(
        currentLanguageTag,
        input.currentLanguageSource ?? null,
        currentLanguageTag,
      );
    }

    return this.result(detectedLanguageTag, "detected", currentLanguageTag);
  }

  async resolve(
    input: ConversationLanguageInput,
  ): Promise<ConversationLanguageResolution> {
    const currentLanguageTag = normalizeLanguageTag(input.currentLanguageTag);
    const explicitLanguageTag = normalizeLanguageTag(input.explicitLanguageTag);

    if (explicitLanguageTag) {
      return this.result(explicitLanguageTag, "customer-explicit", currentLanguageTag);
    }

    if (isStableLanguageSignal(input.message)) {
      const detected = await this.detector.detect(input.message);
      const detectedLanguageTag = normalizeLanguageTag(detected?.languageTag);

      if (
        detectedLanguageTag &&
        typeof detected?.confidence === "number" &&
        detected.confidence >= DETECTION_CONFIDENCE_THRESHOLD
      ) {
        return this.result(detectedLanguageTag, "detected", currentLanguageTag);
      }
    }

    if (currentLanguageTag) {
      return this.result(
        currentLanguageTag,
        input.currentLanguageSource ?? null,
        currentLanguageTag,
      );
    }

    const fallbackCandidates: Array<{
      languageTag: string | null | undefined;
      source: NonNullable<InternationalContext["languageSource"]>;
    }> = [
      { languageTag: input.shopifyLanguageTag, source: "shopify" },
      { languageTag: input.merchantLanguageTag, source: "merchant-default" },
      { languageTag: input.platformLanguageTag, source: "platform-default" },
    ];

    for (const candidate of fallbackCandidates) {
      const languageTag = normalizeLanguageTag(candidate.languageTag);
      if (languageTag) {
        return this.result(languageTag, candidate.source, currentLanguageTag);
      }
    }

    return this.result(null, null, currentLanguageTag);
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