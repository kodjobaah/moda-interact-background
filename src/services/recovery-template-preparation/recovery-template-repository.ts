import type { PrismaClient } from "@prisma/client";
import prisma from "../../lib/db.js";
import type {
  RecoveryTemplatePurpose,
  RecoveryTemplateRepository,
  ShopBrandRow,
  AssignedVariantRow,
} from "./recovery-template.types.js";

/** All reads are tenant-scoped. No provider API or mutable catalogue cache. */
export class PrismaRecoveryTemplateRepository implements RecoveryTemplateRepository {
  constructor(private readonly database: Pick<PrismaClient,
    "shop" | "whatsAppTemplateVariant" | "shopBrand" | "commerceShopProfile"> = prisma) {}

  async readCatalogue(input: {
    shopId: string;
    senderWabaId: string;
    purpose: RecoveryTemplatePurpose;
  }) {
    const shop = await this.database.shop.findUnique({
      where: { id: input.shopId },
      select: { id: true, status: true, defaultLanguageTag: true },
    });
    if (!shop || shop.status !== "ACTIVE") return { shop, variants: [] };
    // Include legacy/unlinked active rows: an unproven row must not make an
    // otherwise ambiguous language slot look uniquely assigned.
    const variants: readonly AssignedVariantRow[] = await this.database.whatsAppTemplateVariant.findMany({
      where: {
        shopId: input.shopId,
        providerAccountId: input.senderWabaId,
        purpose: input.purpose,
        status: "APPROVED",
        enabled: true,
      },
      select: {
        id: true, shopId: true, providerAccountId: true, purpose: true,
        languageTag: true, providerLanguageCode: true,
        providerTemplateName: true, providerTemplateId: true,
        status: true, enabled: true, metaRegistrationId: true,
        metaRegistration: { select: {
          id: true, wabaId: true, providerTemplateName: true,
          providerLanguageCode: true, providerTemplateId: true,
          category: true, providerStatus: true, submissionState: true,
          failureCode: true, lastObservedContentHash: true,
          lastObservedCategory: true, driftDetectedAt: true,
          submittedContentHash: true, componentsSnapshot: true,
          parameterBindingsSnapshot: true,
          locale: { select: {
            id: true, languageTag: true, providerLanguageCode: true,
            status: true, contentHash: true,
            definition: { select: {
              id: true, kind: true, purpose: true, offerType: true,
              status: true, category: true, providerTemplateName: true,
              publishedAt: true, retiredAt: true,
            } },
          } },
        } },
      },
    });
    return { shop, variants };
  }

  async readShopCategory(shopId: string, languageTag: string): Promise<string | null> {
    // The active category is the Moda Store Category mapped onto the Shopify
    // reference taxonomy. Never use a pending category or another tenant's data.
    const profile = await this.database.commerceShopProfile.findUnique({
      where: { shopId },
      select: { activeCategory: { select: {
        enabled: true, displayName: true,
        translations: { where: { locale: languageTag }, select: { displayName: true }, take: 1 },
      } } },
    });
    const category = profile?.activeCategory;
    if (!category?.enabled) return null;
    // Avoid mixing English labels into a reviewed Meta template in another language.
    return languageTag === "en" ? category.displayName : category.translations[0]?.displayName ?? null;
  }

  async readShopBrand(shopId: string): Promise<ShopBrandRow | null> {
    // ShopBrand exists only for some Shopify shops; WooCommerce null is normal.
    // Selecting only needed scalar columns avoids accidental cross-shop material.
    return this.database.shopBrand.findUnique({
      where: { shopId },
      select: {
        brandName: true, logoUrl: true, logoAltText: true,
        logoWidth: true, logoHeight: true,
        squareLogoUrl: true, squareLogoAltText: true,
        coverImageUrl: true,
      },
    });
  }
}
