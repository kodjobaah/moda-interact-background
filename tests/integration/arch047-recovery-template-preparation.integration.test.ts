import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { RecoveryTemplatePreparer } from "../../src/services/recovery-template-preparation/recovery-template-preparer.service.js";
import { PrismaRecoveryTemplateRepository } from "../../src/services/recovery-template-preparation/recovery-template-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;

const now = new Date("2026-10-25T13:30:00.000Z");
const components = [{ type: "BODY", text: "Hello {{1}} {{2}}" }];
const bindings = { header: [], body: [{ position: 1, variable: "customer.firstName" },
  { position: 2, variable: "shopBrand.brandName" }], buttons: [] };
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}
const digest = createHash("sha256").update(stableJson({ schemaVersion: 1, family: "META_RECOVERY",
  category: "MARKETING", components, parameterBindings: bindings })).digest("hex");

integration("ARCH-047-BACKGROUND-001 PostgreSQL authoring/provenance/tenant lookups", () => {
  it("reads only local published, approved Moda registration and shop's own optional brand", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl! });
    const suffix = randomUUID();
    const shopId = `arch047-shop-${suffix}`;
    const otherShopId = `arch047-other-${suffix}`;
    const adminId = `arch047-admin-${suffix}`;
    const definitionId = `arch047-def-${suffix}`;
    const localeId = `arch047-locale-${suffix}`;
    const registrationId = `arch047-meta-${suffix}`;
    const waba = `arch047-waba-${suffix}`;
    const name = `moda_arch047_${suffix.replaceAll("-", "").slice(0, 20)}`;
    try {
      await db.platformAdmin.create({ data: { id: adminId, email: `${suffix}@arch047.example.test`,
        role: "SUPER_ADMIN" } });
      await db.shop.createMany({ data: [
        { id: shopId, domain: `${suffix}.arch047.example.test`, status: "ACTIVE",
          defaultLanguageTag: "en" },
        { id: otherShopId, domain: `other-${suffix}.arch047.example.test`, status: "ACTIVE",
          defaultLanguageTag: "en" },
      ] });
      await db.shopBrand.createMany({ data: [
        { shopId, brandName: "Tenant Brand" },
        { shopId: otherShopId, brandName: "PRIVATE OTHER TENANT" },
      ] });
      await db.whatsAppTemplateDefinition.create({ data: {
        id: definitionId, kind: "META_RECOVERY", purpose: "INITIAL", offerType: "NO_OFFER",
        sourceLanguageTag: "en", astSchemaVersion: 1, sourceHash: "a".repeat(64),
        createdByAdminId: adminId, providerTemplateName: name, category: "MARKETING",
        status: "PUBLISHED", publishedAt: now,
      } });
      await db.whatsAppTemplateLocale.create({ data: {
        id: localeId, definitionId, languageTag: "en", providerLanguageCode: "en_US",
        localeAst: { schemaVersion: 1 }, status: "REVIEWED", contentHash: digest,
      } });
      await db.whatsAppTemplateMetaRegistration.create({ data: {
        id: registrationId, localeId, wabaId: waba, providerTemplateName: name,
        providerLanguageCode: "en_US", category: "MARKETING",
        componentsSnapshot: components as Prisma.InputJsonValue,
        parameterBindingsSnapshot: bindings as Prisma.InputJsonValue,
        submittedContentHash: digest, providerTemplateId: `id-${suffix}`,
        submissionState: "SUBMITTED", providerStatus: "APPROVED",
      } });
      await db.whatsAppTemplateVariant.create({ data: {
        shopId, providerAccountId: waba, purpose: "INITIAL_NO_OFFER", languageTag: "en",
        providerLanguageCode: "en_US", providerTemplateName: name,
        providerTemplateId: `id-${suffix}`, metaRegistrationId: registrationId,
        status: "APPROVED", enabled: true,
      } });
      const readBrand = vi.spyOn(db.shopBrand, "findUnique");
      const repo = new PrismaRecoveryTemplateRepository(db);
      const logger = { warn: vi.fn(), error: vi.fn() };
      const service = new RecoveryTemplatePreparer(repo, async () => waba, async () => null,
        [], () => now, logger);
      const request = { shopId, senderWabaId: waba, stage: "INITIAL" as const,
        offerPresentation: "NO_OFFER" as const, conversationLanguageTag: "en-GB",
        merchantLanguageTag: null, customerFirstName: "Alex" };
      expect(await service.prepare(request)).toMatchObject({
        outcome: "prepared", shopId, definitionId, registrationId,
        canonicalLanguageTag: "en", template: { components: [{
          type: "body", parameters: [{ text: "Alex" }, { text: "Tenant Brand" }],
        }] },
      });
      expect(await service.prepare({ ...request, conversationLanguageTag: "fr",
        merchantLanguageTag: "en" })).toMatchObject({
        outcome: "prepared", selectionSource: "merchant-fallback", canonicalLanguageTag: "en",
      });
      expect(readBrand).toHaveBeenCalledWith({ where: { shopId },
        select: { brandName: true, logoUrl: true, logoAltText: true,
          logoWidth: true, logoHeight: true, squareLogoUrl: true,
          squareLogoAltText: true, coverImageUrl: true } });
      expect(JSON.stringify(logger)).not.toContain("PRIVATE OTHER TENANT");

      // Provider drift blocks this exact assignment, never falling back to
      // another language or a separately existing unproven template.
      await db.whatsAppTemplateMetaRegistration.update({
        where: { id: registrationId }, data: { driftDetectedAt: now },
      });
      expect(await service.prepare(request)).toMatchObject({
        outcome: "unavailable", reason: "PROVIDER_DRIFT",
      });
      // A legacy row on the other shop cannot inherit this shop's registration.
      await db.whatsAppTemplateVariant.create({ data: {
        shopId: otherShopId, providerAccountId: waba, purpose: "INITIAL_NO_OFFER",
        languageTag: "en", providerLanguageCode: "en_US", providerTemplateName: `legacy_${name}`,
        status: "APPROVED", enabled: true,
      } });
      expect(await service.prepare({ ...request, shopId: otherShopId })).toMatchObject({
        outcome: "unavailable", reason: "LEGACY_ASSIGNMENT",
      });
    } finally {
      await db.whatsAppTemplateVariant.deleteMany({ where: { shopId: { in: [shopId, otherShopId] } } });
      await db.whatsAppTemplateMetaRegistration.deleteMany({ where: { id: registrationId } });
      await db.whatsAppTemplateLocale.deleteMany({ where: { id: localeId } });
      await db.whatsAppTemplateDefinition.deleteMany({ where: { id: definitionId } });
      await db.shop.deleteMany({ where: { id: { in: [shopId, otherShopId] } } });
      await db.platformAdmin.deleteMany({ where: { id: adminId } });
      await db.$disconnect();
    }
  }, 40_000);
});
