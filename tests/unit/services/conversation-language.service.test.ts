import { describe, expect, it, vi } from "vitest";
import {
  ConversationLanguageService,
  type LanguageDetector,
} from "../../../src/services/conversation-language.service.js";

const baseInput = {
  message: "Can you help me with this order?",
  currentLanguageTag: "en-GB",
  currentLanguageSource: "shopify" as const,
};

function detector(result: { languageTag: string; confidence: number } | null): LanguageDetector {
  return { detect: vi.fn().mockResolvedValue(result) };
}

describe("ConversationLanguageService", () => {
  it("uses customer-explicit language before detection and fallback context", async () => {
    const service = new ConversationLanguageService(
      detector({ languageTag: "fr-FR", confidence: 0.99 }),
    );

    await expect(
      service.resolve({
        ...baseInput,
        explicitLanguageTag: "de-DE",
        shopifyLanguageTag: "en-GB",
        merchantLanguageTag: "en-US",
        platformLanguageTag: "fr",
      }),
    ).resolves.toEqual({
      languageTag: "de-DE",
      languageSource: "customer-explicit",
      changed: true,
    });
  });

  it("accepts a confident detected switch", async () => {
    const service = new ConversationLanguageService(
      detector({ languageTag: "fr-FR", confidence: 0.92 }),
    );

    await expect(service.resolve(baseInput)).resolves.toEqual({
      languageTag: "fr-FR",
      languageSource: "detected",
      changed: true,
    });
  });

  it.each([
    "ok",
    "👍👍",
    "https://example.com/order/123",
    "12345 99.00",
  ])("does not allow unstable message %j to flap language", async (message) => {
    const detect = vi.fn().mockResolvedValue({ languageTag: "fr-FR", confidence: 0.99 });
    const service = new ConversationLanguageService({ detect });

    await expect(service.resolve({ ...baseInput, message })).resolves.toEqual({
      languageTag: "en-GB",
      languageSource: "shopify",
      changed: false,
    });
    expect(detect).not.toHaveBeenCalled();
  });

  it("does not accept a low-confidence detection", async () => {
    const service = new ConversationLanguageService(
      detector({ languageTag: "fr-FR", confidence: 0.4 }),
    );

    await expect(service.resolve(baseInput)).resolves.toEqual({
      languageTag: "en-GB",
      languageSource: "shopify",
      changed: false,
    });
  });

  it("uses Shopify, merchant and platform fallback in order", async () => {
    const service = new ConversationLanguageService();

    await expect(
      service.resolve({
        ...baseInput,
        currentLanguageTag: null,
        currentLanguageSource: null,
        message: "👍",
        shopifyLanguageTag: "fr-FR",
        merchantLanguageTag: "de-DE",
        platformLanguageTag: "en-US",
      }),
    ).resolves.toMatchObject({ languageTag: "fr-FR", languageSource: "shopify" });

    await expect(
      service.resolve({
        ...baseInput,
        currentLanguageTag: null,
        currentLanguageSource: null,
        message: "👍",
        merchantLanguageTag: "de-DE",
        platformLanguageTag: "en-US",
      }),
    ).resolves.toMatchObject({ languageTag: "de-DE", languageSource: "merchant-default" });
  });

  it("does not use country or currency as language input", async () => {
    const service = new ConversationLanguageService(
      detector({ languageTag: "fr-CA", confidence: 0.95 }),
    );

    const result = await service.resolve({
      ...baseInput,
      message: "Je veux modifier cette commande",
    });

    expect(result).toMatchObject({ languageTag: "fr-CA", languageSource: "detected" });
  });

  it("preserves a more specific same-base locale", () => {
    const service = new ConversationLanguageService();

    expect(
      service.acceptDetectedLanguage({
        message: "Can you help me with this order?",
        currentLanguageTag: "en-GB",
        currentLanguageSource: "shopify",
        detectedLanguageTag: "en",
        detectedLanguageConfidence: 0.98,
      }),
    ).toMatchObject({ languageTag: "en-GB", languageSource: "shopify", changed: false });
  });

  it("accepts a different base language without inventing a region", () => {
    const service = new ConversationLanguageService();

    expect(
      service.acceptDetectedLanguage({
        message: "Bonjour, pouvez-vous m'aider avec ma commande ?",
        currentLanguageTag: "en-GB",
        currentLanguageSource: "shopify",
        detectedLanguageTag: "fr",
        detectedLanguageConfidence: 0.96,
      }),
    ).toMatchObject({ languageTag: "fr", languageSource: "detected", changed: true });
  });

  it("does not override an explicit customer language with detection", () => {
    const service = new ConversationLanguageService();

    expect(
      service.acceptDetectedLanguage({
        message: "Bonjour, pouvez-vous m'aider avec ma commande ?",
        currentLanguageTag: "de-DE",
        currentLanguageSource: "customer-explicit",
        detectedLanguageTag: "fr",
        detectedLanguageConfidence: 0.99,
      }),
    ).toMatchObject({
      languageTag: "de-DE",
      languageSource: "customer-explicit",
      changed: false,
    });
  });

  it("rejects stale or non-linguistic structured detections", () => {
    const service = new ConversationLanguageService();

    expect(
      service.acceptDetectedLanguage({
        message: "👍",
        currentLanguageTag: "en-GB",
        currentLanguageSource: "shopify",
        detectedLanguageTag: "fr",
        detectedLanguageConfidence: 0.99,
      }),
    ).toMatchObject({ languageTag: "en-GB", changed: false });
  });
});