import { describe, expect, it, vi } from "vitest";
import { WhatsAppTemplateSelectorService } from "../../../src/services/whatsapp-template-selector.service.js";

const variant = (overrides: Record<string, unknown> = {}) => ({
  languageTag: "en-US",
  providerLanguageCode: "en_US",
  providerTemplateName: "recovery_en_us",
  providerTemplateId: "tpl_en_us",
  ...overrides,
});

function createSelector(rows: unknown[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const findUnique = vi.fn().mockResolvedValue({ defaultLanguageTag: "en-GB" });
  const selector = new WhatsAppTemplateSelectorService({
    whatsAppTemplateVariant: { findMany },
    shopSettings: { findUnique },
  } as never);

  return { selector, findMany, findUnique };
}

const input = (overrides: Record<string, unknown> = {}) => ({
  shopId: "shop_1",
  providerAccountId: "provider_1",
  purpose: "checkout-recovery",
  languageTag: "en-US",
  countryCode: "CA" as const,
  resolveMarketCapability: vi.fn().mockResolvedValue("supported"),
  ...overrides,
});

describe("WhatsAppTemplateSelectorService", () => {
  it("selects an exact canonical locale and keeps provider language separate", async () => {
    const { selector } = createSelector([variant()]);

    await expect(selector.select(input())).resolves.toMatchObject({
      outcome: "selected",
      canonicalLanguageTag: "en-US",
      providerLanguageCode: "en_US",
      providerTemplateName: "recovery_en_us",
      providerTemplateId: "tpl_en_us",
      selectionSource: "exact",
      marketCapability: "supported",
    });
  });

  it("falls back to an approved base-language variant before merchant language", async () => {
    const { selector } = createSelector([
      variant({ languageTag: "en", providerLanguageCode: "en" }),
      variant({ languageTag: "en-GB", providerLanguageCode: "en_GB" }),
    ]);

    await expect(selector.select(input())).resolves.toMatchObject({
      canonicalLanguageTag: "en",
      providerLanguageCode: "en",
      selectionSource: "base",
    });
  });

  it("uses merchant fallback after customer locale candidates", async () => {
    const { selector } = createSelector([
      variant({ languageTag: "en-GB", providerLanguageCode: "en_GB" }),
    ]);

    await expect(selector.select(input({ languageTag: "fr-CA" }))).resolves.toMatchObject({
      canonicalLanguageTag: "en-GB",
      selectionSource: "merchant-fallback",
    });
  });

  it("uses platform fallback only when explicitly enabled", async () => {
    const rows = [variant({ languageTag: "de", providerLanguageCode: "de" })];
    const disabled = createSelector(rows);
    const enabled = createSelector(rows);

    await expect(
      disabled.selector.select(
        input({
          languageTag: null,
          platformFallbackLanguageTag: "de",
          platformFallbackEnabled: false,
        }),
      ),
    ).resolves.toMatchObject({ outcome: "template-unavailable" });

    await expect(
      enabled.selector.select(
        input({
          languageTag: null,
          platformFallbackLanguageTag: "de",
          platformFallbackEnabled: true,
        }),
      ),
    ).resolves.toMatchObject({
      canonicalLanguageTag: "de",
      selectionSource: "platform-fallback",
    });
  });

  it("scopes the catalogue query to the requested tenant, provider and approved enabled rows", async () => {
    const { selector, findMany } = createSelector([]);

    await selector.select(input());

    expect(findMany).toHaveBeenCalledWith({
      where: {
        shopId: "shop_1",
        providerAccountId: "provider_1",
        purpose: "checkout-recovery",
        status: "APPROVED",
        enabled: true,
      },
      select: {
        languageTag: true,
        providerLanguageCode: true,
        providerTemplateName: true,
        providerTemplateId: true,
      },
    });
  });

  it("returns bounded market-unavailable for unsupported markets", async () => {
    const resolveMarketCapability = vi.fn().mockResolvedValue("unsupported");
    const { selector } = createSelector([variant()]);

    await expect(
      selector.select(input({ resolveMarketCapability })),
    ).resolves.toEqual({
      outcome: "market-unavailable",
      reason: "unsupported-market",
    });
  });

  it("preserves a selected template when market capability is unknown", async () => {
    const resolveMarketCapability = vi.fn().mockResolvedValue("unknown");
    const { selector } = createSelector([variant()]);

    await expect(
      selector.select(input({ resolveMarketCapability })),
    ).resolves.toMatchObject({
      outcome: "provider-check-required",
      canonicalLanguageTag: "en-US",
      marketCapability: "provider-check-required",
    });
  });

  it("does not use country or currency to choose a language", async () => {
    const { selector } = createSelector([
      variant({ languageTag: "fr-CA", providerLanguageCode: "fr" }),
    ]);

    const result = await selector.select(
      input({ languageTag: "fr-CA", countryCode: "US", currencyCode: "USD" }),
    );

    expect(result).toMatchObject({
      canonicalLanguageTag: "fr-CA",
      providerLanguageCode: "fr",
    });
  });
});