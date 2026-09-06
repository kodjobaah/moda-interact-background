import {
  canonicaliseLanguageTag,
  type InternationalContext,
} from "@modainteract/moda-interact-shared/internationalization";
import type { PrismaClient } from "@prisma/client";
import prisma from "../lib/db.js";

export type MarketCapability = "supported" | "unsupported" | "unknown";

export type MarketCapabilityResolver = (input: {
  shopId: string;
  providerAccountId: string;
  countryCode: InternationalContext["countryCode"];
}) => MarketCapability | Promise<MarketCapability>;

export type WhatsAppTemplateSelectionInput = {
  shopId: string;
  providerAccountId: string;
  purpose: string;
  languageTag: string | null;
  countryCode: InternationalContext["countryCode"];
  resolveMarketCapability: MarketCapabilityResolver;
  platformFallbackEnabled?: boolean;
  platformFallbackLanguageTag?: string | null;
};

export type SelectedWhatsAppTemplate = {
  outcome: "selected" | "provider-check-required";
  canonicalLanguageTag: string;
  providerLanguageCode: string;
  providerTemplateName: string;
  providerTemplateId: string | null;
  selectionSource: "exact" | "base" | "merchant-fallback" | "platform-fallback";
  marketCapability: "supported" | "provider-check-required";
};

export type WhatsAppTemplateSelectionResult =
  | SelectedWhatsAppTemplate
  | {
      outcome: "template-unavailable" | "market-unavailable";
      reason:
        | "invalid-language"
        | "missing-language"
        | "no-approved-variant"
        | "ambiguous-approved-variant"
        | "unsupported-market";
    };

type TemplateVariant = {
  languageTag: string;
  providerLanguageCode: string;
  providerTemplateName: string;
  providerTemplateId: string | null;
};

function normalizeLanguageTag(value: string | null): string | null {
  if (!value) {
    return null;
  }

  try {
    return canonicaliseLanguageTag(value);
  } catch {
    return null;
  }
}

function baseLanguageTag(value: string): string {
  return new Intl.Locale(value).language;
}

function uniqueVariant(
  variants: readonly TemplateVariant[],
  languageTag: string,
): TemplateVariant | "ambiguous" | null {
  const matches = variants.filter(
    (variant) => normalizeLanguageTag(variant.languageTag) === languageTag,
  );

  if (matches.length > 1) {
    return "ambiguous";
  }

  return matches[0] ?? null;
}

export class WhatsAppTemplateSelectorService {
  constructor(
    private readonly catalogue: Pick<PrismaClient, "whatsAppTemplateVariant" | "shopSettings"> = prisma,
  ) {}

  async select(
    input: WhatsAppTemplateSelectionInput,
  ): Promise<WhatsAppTemplateSelectionResult> {
    const customerLanguage = normalizeLanguageTag(input.languageTag);
    if (input.languageTag && !customerLanguage) {
      return { outcome: "template-unavailable", reason: "invalid-language" };
    }

    const settings = await this.catalogue.shopSettings.findUnique({
      where: { shopId: input.shopId },
      select: { defaultLanguageTag: true },
    });
    const merchantLanguage = normalizeLanguageTag(settings?.defaultLanguageTag ?? null);
    const platformLanguage = normalizeLanguageTag(input.platformFallbackLanguageTag ?? null);
    const variants = await this.catalogue.whatsAppTemplateVariant.findMany({
      where: {
        shopId: input.shopId,
        providerAccountId: input.providerAccountId,
        purpose: input.purpose,
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

    const candidates: Array<{
      languageTag: string;
      selectionSource: SelectedWhatsAppTemplate["selectionSource"];
    }> = [];

    if (customerLanguage) {
      candidates.push({ languageTag: customerLanguage, selectionSource: "exact" });
      const baseLanguage = baseLanguageTag(customerLanguage);
      if (baseLanguage !== customerLanguage) {
        candidates.push({ languageTag: baseLanguage, selectionSource: "base" });
      }
    }

    if (merchantLanguage && !candidates.some((candidate) => candidate.languageTag === merchantLanguage)) {
      candidates.push({ languageTag: merchantLanguage, selectionSource: "merchant-fallback" });
    }

    if (
      input.platformFallbackEnabled &&
      platformLanguage &&
      !candidates.some((candidate) => candidate.languageTag === platformLanguage)
    ) {
      candidates.push({ languageTag: platformLanguage, selectionSource: "platform-fallback" });
    }

    if (candidates.length === 0) {
      return {
        outcome: "template-unavailable",
        reason: input.languageTag ? "no-approved-variant" : "missing-language",
      };
    }

    for (const candidate of candidates) {
      const variant = uniqueVariant(variants, candidate.languageTag);
      if (variant === "ambiguous") {
        return { outcome: "template-unavailable", reason: "ambiguous-approved-variant" };
      }

      if (!variant) {
        continue;
      }

      const capability = await input.resolveMarketCapability({
        shopId: input.shopId,
        providerAccountId: input.providerAccountId,
        countryCode: input.countryCode,
      });
      if (capability === "unsupported") {
        return { outcome: "market-unavailable", reason: "unsupported-market" };
      }

      return {
        outcome: capability === "unknown" ? "provider-check-required" : "selected",
        canonicalLanguageTag: candidate.languageTag,
        providerLanguageCode: variant.providerLanguageCode,
        providerTemplateName: variant.providerTemplateName,
        providerTemplateId: variant.providerTemplateId,
        selectionSource: candidate.selectionSource,
        marketCapability: capability === "unknown" ? "provider-check-required" : "supported",
      };
    }

    return { outcome: "template-unavailable", reason: "no-approved-variant" };
  }
}

export const whatsappTemplateSelectorService = new WhatsAppTemplateSelectorService();