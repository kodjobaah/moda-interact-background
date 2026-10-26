import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { MetaTemplateRepository } from "../../src/services/meta-template-management/repository.js";
import { observedContentHash } from "../../src/services/meta-template-management/contracts.js";
import { MetaTemplateManagementService } from "../../src/services/meta-template-management/service.js";
import { formatMetaTemplateStatusEventIdentity } from "@modainteract/moda-interact-shared/whatsapp-template-events";

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
    let shopId: string | null = null;
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
        kind: "found", providerId: "987654321", status: "APPROVED", category: "MARKETING",
        observedHash: observedContentHash(components), drift: false,
      })).toBe(true);
      const updated = await repository.load(registration.id);
      expect(updated?.providerTemplateId).toBe("987654321");
      expect(updated?.providerStatus).toBe("APPROVED");
      expect(updated?.submissionState).toBe("SUBMITTED");
      expect(await db.whatsAppTemplateVariant.count({ where: { metaRegistrationId: registration.id } })).toBe(0);
      expect(await db.whatsAppTemplateMetaEvent.count({ where: { registrationId: registration.id } })).toBe(5);
      // A stale read cannot overwrite the current projection.
      expect(await repository.recordReconciliation(current!, { kind: "absent" })).toBe(false);
      // A new independently authenticated status occurrence must fence an
      // APPROVED registration before the next provider network operation.
      const paused = {
        eventIdentity: formatMetaTemplateStatusEventIdentity(randomUUID()),
        wabaId, providerTemplateId: "987654321", providerTemplateName: name,
        providerLanguageCode: "en", providerStatus: "PAUSED",
        occurredAt: new Date().toISOString(),
      };
      const beforePause = await repository.load(registration.id);
      expect(await repository.recordObservation(paused)).toEqual({ duplicate: false, registrationId: registration.id });
      const fenced = await repository.load(registration.id);
      const pending = await db.whatsAppTemplateMetaEvent.findUnique({ where: { eventIdentity: paused.eventIdentity } });
      expect(fenced?.providerStatus).toBe("UNKNOWN");
      expect(fenced?.failureCode).toBe("STATUS_RECONCILIATION_PENDING");
      expect(fenced?.nextRetryAt?.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
      expect(pending?.outcome).toBe("RECONCILIATION_PENDING");
      expect(pending?.processedAt).toBeNull();
      expect(await repository.recordReconciliation(beforePause!, { kind: "found",
        providerId: "987654321", status: "APPROVED", category: "MARKETING",
        observedHash: observedContentHash(components), drift: false })).toBe(false);
      const failedRead = new Error("Meta unavailable");
      const reporting = { info: () => undefined, warn: () => undefined, error: () => undefined };
      const service = new MetaTemplateManagementService(repository, {
        verifyWaba: async () => undefined,
        find: async () => { throw failedRead; },
        create: async () => { throw new Error("Unexpected POST"); },
      }, reporting as never);
      await expect(service.processTemplateStatusObservation(paused)).rejects.toBe(failedRead);
      expect((await repository.load(registration.id))?.providerStatus).toBe("UNKNOWN");
      expect((await db.whatsAppTemplateMetaEvent.findUnique({ where: { eventIdentity: paused.eventIdentity } }))?.processedAt).toBeNull();
      const resolved = await repository.load(registration.id);
      expect(await repository.recordReconciliation(resolved!, { kind: "found",
        providerId: "987654321", status: "PAUSED", category: "MARKETING",
        observedHash: observedContentHash(components), drift: false })).toBe(true);
      expect((await repository.load(registration.id))?.providerStatus).toBe("PAUSED");
      expect((await db.whatsAppTemplateMetaEvent.findUnique({ where: { eventIdentity: paused.eventIdentity } }))?.processedAt).not.toBeNull();
      // Identical provider fields but a distinct v2 UUID are not suppressed.
      const repeat = { ...paused, eventIdentity: formatMetaTemplateStatusEventIdentity(randomUUID()) };
      expect(await repository.recordObservation(repeat)).toEqual({ duplicate: false, registrationId: registration.id });
      expect((await repository.load(registration.id))?.providerStatus).toBe("UNKNOWN");
      const conflicting = { ...paused,
        eventIdentity: formatMetaTemplateStatusEventIdentity(randomUUID()),
        providerTemplateId: "111111111", providerStatus: "DISABLED" };
      expect(await repository.recordObservation(conflicting)).toEqual({ duplicate: false, registrationId: registration.id });
      const mismatch = await repository.load(registration.id);
      expect(mismatch?.providerTemplateId).toBe("987654321");
      expect(mismatch?.providerStatus).toBe("UNKNOWN");
      expect(mismatch?.failureCode).toBe("PROVIDER_ID_CONFLICT");
      const mismatchEvent = await db.whatsAppTemplateMetaEvent.findUnique({
        where: { eventIdentity: conflicting.eventIdentity },
      });
      expect(mismatchEvent?.failureCode).toBe("PROVIDER_ID_CONFLICT");
      expect(mismatchEvent?.processedAt).toBeNull();
      // Publication later than initial submission must not inherit a six-hour
      // dormant retry: an enabled shop variant is due after 30 minutes.
      const shop = await db.shop.create({ data: { domain: `bg003-${suffix}.example.invalid` } });
      shopId = shop.id;
      await db.whatsAppTemplateVariant.create({ data: {
        shopId: shop.id, providerAccountId: wabaId, purpose: "INITIAL",
        languageTag: "en", providerLanguageCode: "en",
        providerTemplateName: name, providerTemplateId: "987654321",
        metaRegistrationId: registration.id, status: "APPROVED", enabled: true,
      } });
      await db.whatsAppTemplateMetaRegistration.update({
        where: { id: registration.id },
        data: { submissionState: "SUBMITTED", providerStatus: "APPROVED", failureCode: null,
          lastReconciledAt: new Date(Date.now() - 31 * 60_000),
          nextRetryAt: new Date(Date.now() + 6 * 60 * 60_000) },
      });
      expect((await repository.listDue(25)).map((row) => row.id)).toContain(registration.id);
      const assigned = await repository.load(registration.id);
      expect(await repository.recordReconciliation(assigned!, { kind: "found",
        providerId: "987654321", status: "APPROVED", category: "MARKETING",
        observedHash: observedContentHash(components), drift: false })).toBe(true);
      const afterRefresh = await repository.load(registration.id);
      expect(afterRefresh?.nextRetryAt?.getTime()).toBeLessThanOrEqual(Date.now() + 31 * 60_000);
    } finally {
      if (definitionId) {
        const registrations = await db.whatsAppTemplateMetaRegistration.findMany({ where: { locale: { definitionId } }, select: { id: true } });
        const ids = registrations.map((r) => r.id);
        await db.whatsAppTemplateMetaEvent.deleteMany({ where: { registrationId: { in: ids } } });
        await db.whatsAppTemplateVariant.deleteMany({ where: { metaRegistrationId: { in: ids } } });
        await db.whatsAppTemplateMetaRegistration.deleteMany({ where: { id: { in: ids } } });
        await db.whatsAppTemplateLocale.deleteMany({ where: { definitionId } });
        await db.whatsAppTemplateDefinition.delete({ where: { id: definitionId } });
      }
      if (shopId) await db.shop.delete({ where: { id: shopId } });
      await db.platformAdmin.delete({ where: { id: admin.id } });
      await db.$disconnect();
    }
  });
});
