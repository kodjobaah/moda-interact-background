import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { MetaGraphTemplateAdapter } from "../../src/services/meta-template-management/meta-graph.adapter.js";
import { MetaTemplateRepository } from "../../src/services/meta-template-management/repository.js";
import { MetaTemplateManagementService } from "../../src/services/meta-template-management/service.js";

// Mock only Meta's credential lookup and HTTP transport. Prisma, claims,
// event receipts and retry/reconciliation persistence remain real.
vi.mock("../../src/services/platform-configuration/consumers.js", () => ({
  platformConsumerConfiguration: { read: vi.fn(async () => ({ value: {
    accessToken: "bg003-test-only-token", businessAccountId: "123456789", phoneNumberId: "999999",
  } })) },
}));

const databaseUrl = process.env.TEST_DATABASE_URL;
const disposable = databaseUrl && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;
const components = [{ type: "BODY", text: "You left a basket" }];

async function withFreshRegistration(run: (input: {
  db: PrismaClient; registrationId: string; name: string;
}) => Promise<void>) {
  const db = new PrismaClient({ datasourceUrl: databaseUrl! });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 18);
  const name = `moda_bg003_${suffix}`;
  let adminId: string | undefined;
  let definitionId: string | undefined;
  let registrationId: string | undefined;
  try {
    const admin = await db.platformAdmin.create({ data: { email: `bg003-http-${suffix}@example.invalid` } });
    adminId = admin.id;
    const definition = await db.whatsAppTemplateDefinition.create({ data: {
      kind: "META_RECOVERY", purpose: "INITIAL", offerType: "NO_OFFER",
      providerTemplateName: name, category: "MARKETING", sourceLanguageTag: "en",
      astSchemaVersion: 1, sourceHash: "b".repeat(64), status: "SAVED",
      createdByAdminId: admin.id,
    } });
    definitionId = definition.id;
    const locale = await db.whatsAppTemplateLocale.create({ data: {
      definitionId: definition.id, languageTag: "en", providerLanguageCode: "en",
      contentHash: "a".repeat(64), status: "REVIEWED",
      reviewedAt: new Date(), reviewedByAdminId: admin.id,
    } });
    const registration = await db.whatsAppTemplateMetaRegistration.create({ data: {
      localeId: locale.id, wabaId: "123456789", providerTemplateName: name,
      providerLanguageCode: "en", category: "MARKETING",
      componentsSnapshot: components, parameterBindingsSnapshot: {},
      submittedContentHash: "a".repeat(64), submissionState: "READY_TO_SUBMIT",
    } });
    registrationId = registration.id;
    await run({ db, registrationId, name });
  } finally {
    if (registrationId) {
      await db.whatsAppTemplateMetaEvent.deleteMany({ where: { registrationId } });
      await db.whatsAppTemplateMetaRegistration.deleteMany({ where: { id: registrationId } });
    }
    if (definitionId) {
      await db.whatsAppTemplateLocale.deleteMany({ where: { definitionId } });
      await db.whatsAppTemplateDefinition.deleteMany({ where: { id: definitionId } });
    }
    if (adminId) await db.platformAdmin.deleteMany({ where: { id: adminId } });
    await db.$disconnect();
  }
}

disposable("ARCH-047-BG003 durable Meta HTTP failure/rejection outcomes", () => {
  it.each(["http-503", "validation-400"] as const)(
    "%s: persists the provider classification and never blindly POSTs on replay", async (scenario) => {
      await withFreshRegistration(async ({ db, registrationId, name }) => {
        let getCount = 0;
        let postCount = 0;
        const transport = vi.fn(async (url: URL, init: RequestInit) => {
          expect(url.pathname).toMatch(/\/123456789\/message_templates$/);
          if (init.method === "GET") {
            expect(url.searchParams.get("name")).toBe(name);
            getCount += 1;
            if (scenario === "http-503" && getCount > 1) {
              return new Response(JSON.stringify({ data: [{
                id: "987654321", name, language: "en", category: "MARKETING",
                status: "APPROVED", components,
              }] }), { status: 200 });
            }
            return new Response(JSON.stringify({ data: [] }), { status: 200 });
          }
          expect(init.method).toBe("POST");
          postCount += 1;
          return new Response("provider body must not enter logs", {
            status: scenario === "http-503" ? 503 : 400,
          });
        });
        const reporter = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const repository = new MetaTemplateRepository(db);
        const service = new MetaTemplateManagementService(repository,
          new MetaGraphTemplateAdapter(transport as unknown as typeof fetch), reporter as never);

        if (scenario === "http-503") {
          await expect(service.submitPreparedRegistration(registrationId)).rejects.toMatchObject({
            code: "META_HTTP_503", disposition: "uncertain",
          });
        } else {
          await expect(service.submitPreparedRegistration(registrationId)).resolves.toEqual({
            kind: "failed", code: "META_HTTP_400",
          });
        }

        const row = await db.whatsAppTemplateMetaRegistration.findUniqueOrThrow({
          where: { id: registrationId },
        });
        const expectedState = scenario === "http-503" ? "SUBMISSION_UNKNOWN" : "FAILED";
        const expectedCode = scenario === "http-503" ? "META_HTTP_503" : "META_HTTP_400";
        expect(row.submissionState).toBe(expectedState);
        expect(row.failureCode).toBe(expectedCode);
        expect(row.providerTemplateId).toBeNull();
        expect(row.nextRetryAt === null).toBe(scenario === "validation-400");
        if (scenario === "http-503") expect(row.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
        expect(await db.whatsAppTemplateMetaEvent.count({
          where: { registrationId, eventType: "CREATE_INTENT" },
        })).toBe(1);
        expect(await db.whatsAppTemplateMetaEvent.count({
          where: { registrationId, eventType: "POST_INTENT" },
        })).toBe(1);
        expect(await db.whatsAppTemplateMetaEvent.count({
          where: { registrationId, eventType: "CREATE_RESULT", outcome: expectedState,
            failureCode: expectedCode },
        })).toBe(1);
        expect(await repository.claim(registrationId, "123456789")).toBeNull();
        // A retry schedule lives in PostgreSQL; it cannot create a second POST.
        expect((await repository.listDue(25)).some((item) => item.id === registrationId)).toBe(false);

        if (scenario === "http-503") {
          // POST may have reached Meta despite HTTP failure. The next attempt
          // must GET the exact WABA/name/language and adopt only with POST_INTENT.
          await expect(service.submitPreparedRegistration(registrationId)).resolves.toEqual({
            kind: "already-submitted", providerId: "987654321",
          });
          const reconciled = await db.whatsAppTemplateMetaRegistration.findUniqueOrThrow({
            where: { id: registrationId },
          });
          expect(reconciled.submissionState).toBe("SUBMITTED");
          expect(reconciled.providerTemplateId).toBe("987654321");
          expect(reconciled.providerStatus).toBe("APPROVED");
          expect(await db.whatsAppTemplateMetaEvent.count({
            where: { registrationId, eventType: "RECONCILE", outcome: "CURRENT" },
          })).toBe(1);
          expect(getCount).toBe(2);
        } else {
          // A definitive validation rejection is terminal FAILED, not an
          // uncertain create awaiting GET or a fresh POST.
          await expect(service.submitPreparedRegistration(registrationId)).resolves.toEqual({
            kind: "busy", code: "NOT_READY_TO_SUBMIT",
          });
          expect((await repository.listDue(25)).some((item) => item.id === registrationId)).toBe(false);
          expect(getCount).toBe(1);
          expect(await db.whatsAppTemplateMetaEvent.count({
            where: { registrationId, eventType: "RECONCILE" },
          })).toBe(0);
        }
        expect(postCount).toBe(1);
        expect(reporter.error).toHaveBeenCalledWith("meta.template.create.error",
          expect.objectContaining({ registrationId, code: expectedCode }));
        expect(JSON.stringify(reporter.error.mock.calls)).not.toContain("provider body must not enter logs");
        expect(JSON.stringify(reporter.error.mock.calls)).not.toContain("bg003-test-only-token");
      });
    }, 30_000,
  );
});
