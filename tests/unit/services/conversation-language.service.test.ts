import { describe, expect, it } from "vitest";
import {
  ConversationLanguageService,
  isStableLanguageSignal,
} from "../../../src/services/conversation-language.service.js";

const service = new ConversationLanguageService();

const currentEnglish = {
  message: "Can you help me with this order?",
  currentLanguageTag: "en-GB",
  currentLanguageSource: "shopify" as const,
};

describe("ConversationLanguageService", () => {
  it("resolves explicit, established, Shopify, merchant and platform initial language in order", () => {
    expect(
      service.resolveInitialLanguage({
        currentLanguageTag: "en-GB",
        currentLanguageSource: "shopify",
        explicitLanguageTag: "de-DE",
        shopifyLanguageTag: "fr-FR",
        merchantLanguageTag: "it-IT",
        platformLanguageTag: "es",
      }),
    ).toEqual({
      languageTag: "de-DE",
      languageSource: "customer-explicit",
      changed: true,
    });

    expect(
      service.resolveInitialLanguage({
        currentLanguageTag: "fr",
        currentLanguageSource: "detected",
        merchantLanguageTag: "en-GB",
      }),
    ).toEqual({
      languageTag: "fr",
      languageSource: "detected",
      changed: false,
    });

    expect(
      service.resolveInitialLanguage({
        currentLanguageTag: null,
        currentLanguageSource: null,
        shopifyLanguageTag: "fr-FR",
        merchantLanguageTag: "de-DE",
        platformLanguageTag: "en-US",
      }),
    ).toMatchObject({ languageTag: "fr-FR", languageSource: "shopify" });

    expect(
      service.resolveInitialLanguage({
        currentLanguageTag: null,
        currentLanguageSource: null,
        merchantLanguageTag: "de-DE",
        platformLanguageTag: "en-US",
      }),
    ).toMatchObject({ languageTag: "de-DE", languageSource: "merchant-default" });

    expect(
      service.resolveInitialLanguage({
        currentLanguageTag: null,
        currentLanguageSource: null,
        platformLanguageTag: "en-US",
      }),
    ).toMatchObject({ languageTag: "en-US", languageSource: "platform-default" });
  });

  it.each([
    ["", false],
    ["ok", false],
    ["👍👍", false],
    ["https://example.com/order/123", false],
    ["12345 99.00", false],
    ["Please help with this order", true],
    ["Bonjour, aidez-moi avec cette commande", true],
  ])("classifies %j as stable=%s", (message, stable) => {
    expect(isStableLanguageSignal(message)).toBe(stable);
  });

  it("accepts a different-base language only above 80% confidence", () => {
    expect(
      service.evaluateDetectedLanguage({
        ...currentEnglish,
        detectedLanguageTag: "fr",
        detectedLanguageConfidence: 0.81,
      }),
    ).toEqual({
      languageTag: "fr",
      languageSource: "detected",
      changed: true,
      reason: "accepted",
    });

    expect(
      service.evaluateDetectedLanguage({
        ...currentEnglish,
        detectedLanguageTag: "fr",
        detectedLanguageConfidence: 0.8,
      }),
    ).toEqual({
      languageTag: "en-GB",
      languageSource: "shopify",
      changed: false,
      reason: "low-confidence",
    });
  });

  it("preserves an established more-specific locale for the same base language", () => {
    expect(
      service.evaluateDetectedLanguage({
        ...currentEnglish,
        detectedLanguageTag: "en",
        detectedLanguageConfidence: 0.98,
      }),
    ).toEqual({
      languageTag: "en-GB",
      languageSource: "shopify",
      changed: false,
      reason: "same-base-language",
    });
  });

  it("keeps non-recovery customer-explicit language immutable", () => {
    expect(
      service.evaluateDetectedLanguage({
        message: "Bonjour, pouvez-vous m'aider avec ma commande ?",
        currentLanguageTag: "de-DE",
        currentLanguageSource: "customer-explicit",
        detectedLanguageTag: "fr",
        detectedLanguageConfidence: 0.99,
      }),
    ).toEqual({
      languageTag: "de-DE",
      languageSource: "customer-explicit",
      changed: false,
      reason: "customer-explicit",
    });
  });

  it("allows recovery detection to supersede a legacy customer-explicit source", () => {
    expect(
      service.evaluateDetectedLanguage({
        recoveryConversation: true,
        message: "Hello, can you help with this order?",
        currentLanguageTag: "fr",
        currentLanguageSource: "customer-explicit",
        detectedLanguageTag: "en",
        detectedLanguageConfidence: 0.99,
      }),
    ).toEqual({
      languageTag: "en",
      languageSource: "detected",
      changed: true,
      reason: "accepted",
    });
  });

  it.each([
    {
      name: "unstable input",
      input: {
        ...currentEnglish,
        message: "👍",
        detectedLanguageTag: "fr",
        detectedLanguageConfidence: 0.99,
      },
      reason: "unstable-input",
    },
    {
      name: "invalid tag",
      input: {
        ...currentEnglish,
        detectedLanguageTag: "invalid_@@",
        detectedLanguageConfidence: 0.99,
      },
      reason: "invalid-tag",
    },
    {
      name: "missing confidence",
      input: {
        ...currentEnglish,
        detectedLanguageTag: "fr",
        detectedLanguageConfidence: null,
      },
      reason: "invalid-confidence",
    },
    {
      name: "out-of-range confidence",
      input: {
        ...currentEnglish,
        detectedLanguageTag: "fr",
        detectedLanguageConfidence: 1.1,
      },
      reason: "invalid-confidence",
    },
    {
      name: "low confidence",
      input: {
        ...currentEnglish,
        detectedLanguageTag: "fr",
        detectedLanguageConfidence: 0.4,
      },
      reason: "low-confidence",
    },
  ])("rejects $name", ({ input, reason }) => {
    expect(service.evaluateDetectedLanguage(input)).toEqual({
      languageTag: "en-GB",
      languageSource: "shopify",
      changed: false,
      reason,
    });
  });
});
