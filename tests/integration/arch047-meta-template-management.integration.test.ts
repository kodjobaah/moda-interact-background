import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { MetaTemplateRepository } from "../../src/services/meta-template-management/repository.js";
import { observedContentHash } from "../../src/services/meta-template-management/contracts.js";

const url = process.env.TEST_DATABASE_URL;
const pg = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

pg("ARCH-047-BG003 durable Meta intent / webhook evidence", () => {
  it("atomically claims once, stores uncertain intent, deduplicates Meta observations, and projects without shop activation", async () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const suffix = randomUUID().replaceAll("-", "").slice(0, 20);
    const wabaId = "123456789";
    const name = `moda_bg003_${suffix}`;
    const components = [{ type: "BODY", text: "You left a basket" }];
    const hash = "a".repeat(64);
    const admin = await db.platformAdmin.create({ data: { email: `bg003-${suffix}@example.invalid` } });
    let definitionId: string | null = null;
    try {
      const definition = await db.whatsAppTemplateDefinition.create({ data: {
        kind: "META_RECOVERY", purpose: "INITIAL", offerType: "NO_OFFER",
        providerTemplateName: name, category: "MARKETING", sourceLanguageTag: "en",
        astSchemaVersion: 1, sourceHash: "b".repeat(64), status: "SAVED",
        createdByAdminId: admin.id,
      } });
      definitionId = definition.id;
      const locale = await db.whatsAppTemplateLocale.create({ data: {
        definitionId: definition.id, languageTag: "en", providerLanguageCode: "en",
        contentHash: hash, status: "REVIEWED", reviewedAt: new Date(), reviewedByAdminId: admin.id,
      } });
      const registration = await db.whatsAppTemplateMetaRegistration.create({ data: {
        localeId: locale.id, wabaId, providerTemplateName: name,
        providerLanguageCode: "en", category: "MARKETING",
        componentsSnapshot: components, parameterBindingsSnapshot: {},
        submittedContentHash: hash, submissionState: "READY_TO_SUBMIT",
      } });
      const repository = new MetaTemplateRepository(db);
      const [first, second] = await Promise.all([
        repository.claim(registration.id, wabaId),
        repository.claim(registration.id, wabaId),
      ]);
      const claims = [first, second].filter((item) => item !== null);
      expect(claims).toHaveLength(1);
      expect(await db.whatsAppTemplateMetaEvent.count({ where: { registrationId: registration.id, eventType: "CREATE_INTENT" } })).toBe(1);
      await repository.recordPostIntent(claims[0]!);
      expect(await repository.finishSubmission(claims[0]!, { kind: "unknown", code: "META_TRANSPORT_UNKNOWN" })).toBe(true);
      expect(await repository.claim(registration.id, wabaId)).toBeNull();
      const observation = {
        eventIdentity: `bg003:${suffix}:status`, wabaId,
        providerTemplateName: name, providerLanguageCode: "en",
        providerStatus: "APPROVED", occurredAt: new Date().toISOString(),
      };
      expect(await repository.recordObservation(observation)).toEqual({ duplicate: false, registrationId: registration.id });
      expect(await repository.recordObservation(observation)).toEqual({ duplicate: true, registrationId: registration.id });
      expect(await db.whatsAppTemplateMetaEvent.count({ where: { eventIdentity: observation.eventIdentity } })).toBe(1);
      const current = await repository.load(registration.id);
      expect(current).not.toBeNull();
      expect(await repository.recordReconciliation(current!, {
        kind: "found", providerId: "provider-123", status: "APPROVED", category: "MARKETING",
        observedHash: observedContentHash(components), drift: false,
      })).toBe(true);
      const updated = await repository.load(registration.id);
      expect(updated?.providerTemplateId).toBe("provider-123");
      expect(updated?.providerStatus).toBe("APPROVED");
      expect(updated?.submissionState).toBe("SUBMITTED");
      expect(await db.whatsAppTemplateVariant.count({ where: { metaRegistrationId: registration.id } })).toBe(0);
      expect(await db.whatsAppTemplateMetaEvent.count({ where: { registrationId: registration.id } })).toBe(5);
      // A stale read cannot overwrite the current projection.
      expect(await repository.recordReconciliation(current!, { kind: "absent" })).toBe(false);
    } finally {
      if (definitionId) {
        const registrations = await db.whatsAppTemplateMetaRegistration.findMany({ where: { locale: { definitionId } }, select: { id: true } });
        const ids = registrations.map((r) => r.id);
        await db.whatsAppTemplateMetaEvent.deleteMany({ where: { registrationId: { in: ids } } });
        await db.whatsAppTemplateMetaRegistration.deleteMany({ where: { id: { in: ids } } });
        await db.whatsAppTemplateLocale.deleteMany({ where: { definitionId } });
        await db.whatsAppTemplateDefinition.delete({ where: { id: definitionId } });
      }
      await db.platformAdmin.delete({ where: { id: admin.id } });
      await db.$disconnect();
    }
  });
});
