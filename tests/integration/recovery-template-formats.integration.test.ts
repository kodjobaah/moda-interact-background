import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { observedContentHash } from "../../src/services/meta-template-management/contracts.js";
import { RecoveryTemplatePreparer } from "../../src/services/recovery-template-preparation/recovery-template-preparer.service.js";
import { PrismaRecoveryTemplateRepository } from "../../src/services/recovery-template-preparation/recovery-template-repository.js";
import { ShopBrandReadyMediaAdapter } from "../../src/services/shop-brand-media-runtime/resolver.js";
import { PrismaShopBrandMediaReader } from "../../src/services/shop-brand-media-runtime/repository.js";
import { readyEvaluation } from "../unit/fixtures/initial-outreach-evaluation.js";

const url = process.env.TEST_DATABASE_URL;
const integration = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
const stable = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value) :
  Array.isArray(value) ? `[${value.map(stable).join(",")}]` :
    `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
const now = new Date("2026-10-25T13:30:00.000Z");

integration("Recovery format coexistence for Shopify and WooCommerce", () => {
  it("selects the assigned approved fallback without branding, preserves both assignments and honours exact follow-ups", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const suffix = randomUUID().replaceAll("-", "");
    const adminId = `format-admin-${suffix}`;
    const wabaId = `format-waba-${suffix}`;
    const shops = ["SHOPIFY", "WOOCOMMERCE"].map((platform) => ({ platform: platform as "SHOPIFY" | "WOOCOMMERCE",
      id: `${platform.toLowerCase()}-${suffix}`, domain: `${platform.toLowerCase()}-${suffix}.example.com`, defaultLanguageTag: "en" }));
    const definitions: string[] = [];
    const registrations: string[] = [];
    const logger = { warn: vi.fn(), error: vi.fn() };
    try {
      await db.platformAdmin.create({ data: { id: adminId, email: `${suffix}@formats.example.com`, role: "SUPER_ADMIN" } });
      await db.shop.createMany({ data: shops });
      await db.shopBrand.create({ data: { shopId: shops[0]!.id, brandName: "Shopify Merchant",
        whatsAppMedia: { schemaVersion: 1, roles: {}, shopifySourceSync: { failureCode: "CHANNEL_LOCKED" } } } });
      const names = new Map<string, string>();
      for (const stage of ["INITIAL", "FOLLOW_UP"] as const) {
        for (const format of ["TEXT", "IMAGE"] as const) {
          const key = `${stage}_${format}`;
          const name = `moda_${key.toLowerCase()}_${suffix}`;
          names.set(key, name);
          const definitionId = `definition-${name}`;
          const localeId = `locale-${name}`;
          const registrationId = `registration-${name}`;
          const providerId = `provider-${name}`;
          const components = [...(format === "IMAGE" ? [{ type: "HEADER", format: "IMAGE" }] : []),
            { type: "BODY", text: stage === "INITIAL" ? "Shop: {{1}}. Basket: {{2}}. Use Reply on this message, then text or a voice note (up to 2 minutes)." : "Shop: {{1}}. Your checkout awaits." }];
          const bindings = { promotionTarget: "CHECKOUT", ...(format === "IMAGE" ? { schemaVersion: 1, headerMediaRole: "LOGO" } : {}),
            header: [], body: [{ position: 1, variable: "shop.name" },
              ...(stage === "INITIAL" ? [{ position: 2, variable: "checkout.itemsSummary" }] : [])], buttons: [] };
          const digest = createHash("sha256").update(stable({ schemaVersion: 1, family: "META_RECOVERY", category: "MARKETING", components, parameterBindings: bindings })).digest("hex");
          await db.whatsAppTemplateDefinition.create({ data: { id: definitionId, kind: "META_RECOVERY", purpose: stage,
            offerType: "NO_OFFER", sourceLanguageTag: "en", astSchemaVersion: 1, sourceHash: "a".repeat(64),
            createdByAdminId: adminId, providerTemplateName: name, category: "MARKETING", status: "PUBLISHED", publishedAt: now } });
          definitions.push(definitionId);
          await db.whatsAppTemplateLocale.create({ data: { id: localeId, definitionId, languageTag: "en", providerLanguageCode: "en_US",
            localeAst: { schemaVersion: 1 }, status: "REVIEWED", contentHash: digest } });
          await db.whatsAppTemplateMetaRegistration.create({ data: { id: registrationId, localeId, wabaId,
            providerTemplateName: name, providerLanguageCode: "en_US", providerTemplateId: providerId, category: "MARKETING",
            componentsSnapshot: components, parameterBindingsSnapshot: bindings, submittedContentHash: digest,
            submissionState: "SUBMITTED", providerStatus: "APPROVED", lastReconciledAt: now,
            lastObservedCategory: "MARKETING", lastObservedContentHash: observedContentHash(components as Parameters<typeof observedContentHash>[0]) } });
          registrations.push(registrationId);
          await db.whatsAppTemplateVariant.createMany({ data: shops.map(shop => ({ shopId: shop.id,
            providerAccountId: wabaId, purpose: `${stage}_NO_OFFER`, languageTag: "en", providerLanguageCode: "en_US",
            providerTemplateName: name, providerTemplateId: providerId, metaRegistrationId: registrationId,
            enabled: true, status: "APPROVED" as const })) });
        }
      }
      const media = new ShopBrandReadyMediaAdapter(new PrismaShopBrandMediaReader(db), async () => ({ publicOrigin: "https://assets.modainteract.com" }));
      const service = new RecoveryTemplatePreparer(new PrismaRecoveryTemplateRepository(db), async () => wabaId,
        media.resolve, media.approvedHosts, () => now, logger);
      for (const shop of shops) {
        const lineItems = [{ title: "Saved basket item", quantity: 1 }];
        const request = { shopId: shop.id, senderWabaId: wabaId, offerPresentation: "NO_OFFER" as const,
          promotionTarget: "CHECKOUT" as const, conversationLanguageTag: "en", merchantLanguageTag: "en",
          shopName: { shopId: shop.id, value: shop.domain }, checkoutItems: { shopId: shop.id, lineItems },
          checkout: { shopId: shop.id, url: `https://${shop.domain}/checkout/saved`, approvedHosts: [shop.domain],
            lastExternalActivityAt: new Date(now.getTime() - 15_000), expiresAt: null, checkoutRecoveryLifetimeDays: 21 },
          outreachEvaluation: readyEvaluation(shop.id, "attempt-1", lineItems) };
        for (const stage of ["INITIAL", "FOLLOW_UP"] as const) {
          const text = names.get(`${stage}_TEXT`)!;
          expect(await service.prepare({ ...request, stage })).toMatchObject({ outcome: "prepared", shopId: shop.id,
            purpose: `${stage}_NO_OFFER`, providerTemplateName: text });
        }
        expect(await service.prepare({ ...request, stage: "FOLLOW_UP", selection: { kind: "EXACT",
          templateName: names.get("FOLLOW_UP_IMAGE")!, languageCode: "en_US" } })).toMatchObject({ outcome: "unavailable", reason: "MEDIA_NOT_READY" });
        expect(await service.prepare({ ...request, stage: "FOLLOW_UP", selection: { kind: "EXACT",
          templateName: names.get("FOLLOW_UP_TEXT")!, languageCode: "en_US" } })).toMatchObject({ outcome: "prepared",
            providerTemplateName: names.get("FOLLOW_UP_TEXT") });
        expect(await db.whatsAppTemplateVariant.count({ where: { shopId: shop.id, providerAccountId: wabaId,
          enabled: true, status: "APPROVED" } })).toBe(4);
      }
    } finally {
      await db.whatsAppTemplateVariant.deleteMany({ where: { providerAccountId: wabaId } });
      await db.whatsAppTemplateMetaRegistration.deleteMany({ where: { id: { in: registrations } } });
      await db.whatsAppTemplateLocale.deleteMany({ where: { definitionId: { in: definitions } } });
      await db.whatsAppTemplateDefinition.deleteMany({ where: { id: { in: definitions } } });
      await db.shop.deleteMany({ where: { id: { in: shops.map(shop => shop.id) } } });
      await db.platformAdmin.deleteMany({ where: { id: adminId } });
      await db.$disconnect();
    }
  }, 40_000);
});
