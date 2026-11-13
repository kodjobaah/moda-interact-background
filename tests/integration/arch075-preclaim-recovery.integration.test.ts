import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { MetaPreclaimRecovery } from "../../src/services/meta-template-management/preclaim-recovery.js";
import { MetaTemplateRepository } from "../../src/services/meta-template-management/repository.js";
import { MetaTemplateManagementService } from "../../src/services/meta-template-management/service.js";
import { fingerprint } from "../../src/services/meta-template-management/contracts.js";
const pg = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;
const config = { wabaId: "123456789", appId: "987654321" };
const proof = { service: "moda-messaging-worker", reference: "test:deployment-proof" } as const;
const code = "META_APP_ID_MISSING_OR_INVALID";
async function fixture(run: (f: Awaited<ReturnType<typeof seed>>, db: PrismaClient) => Promise<void>) {
  const db = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
  const f = await seed(db);
  try { await run(f, db); } finally {
    await db.whatsAppTemplateMetaEvent.deleteMany({ where: { registrationId: f.row.id } });
    await db.whatsAppTemplateMetaRegistration.delete({ where: { id: f.row.id } });
    await db.whatsAppTemplateLocale.deleteMany({ where: { definitionId: f.definition.id } });
    await db.whatsAppTemplateDefinition.delete({ where: { id: f.definition.id } });
    await db.platformAdmin.delete({ where: { id: f.admin.id } });
    await db.$disconnect();
  }
}
async function seed(db: PrismaClient) {
  const suffix = randomUUID().replaceAll("-", "");
  const admin = await db.platformAdmin.create({ data: { email: `${suffix}@example.invalid` } });
  const definition = await db.whatsAppTemplateDefinition.create({ data: {
    kind: "META_RECOVERY", purpose: "INITIAL", providerTemplateName: `recover_${suffix}`, category: "MARKETING",
    sourceLanguageTag: "en", astSchemaVersion: 1, sourceHash: "b".repeat(64), status: "SAVED", createdByAdminId: admin.id,
  } });
  const locale = await db.whatsAppTemplateLocale.create({ data: { definitionId: definition.id,
    languageTag: "en", providerLanguageCode: "en", contentHash: "a".repeat(64), status: "REVIEWED",
    reviewedAt: new Date(), reviewedByAdminId: admin.id } });
  const row = await db.whatsAppTemplateMetaRegistration.create({ data: { localeId: locale.id, ...{ wabaId: config.wabaId },
    providerTemplateName: definition.providerTemplateName!, providerLanguageCode: "en", category: "MARKETING",
    componentsSnapshot: [{ type: "BODY", text: "Synthetic reviewed recovery" }], parameterBindingsSnapshot: {},
    submittedContentHash: "a".repeat(64), submissionState: "READY_TO_SUBMIT" } });
  const repository = new MetaTemplateRepository(db);
  await repository.blockReadyRegistration(row.id, code);
  return { admin, definition, locale, row, repository, recovery: new MetaPreclaimRecovery(db, async () => config) };
}
pg("ARCH-075 bounded preclaim app block recovery", () => {
  it("repairs the historical dead end only through explicit digest apply, preserving history and ordinary guards", async () => {
    await fixture(async (f, db) => {
      const provider = { verifyWaba: async () => undefined,
        find: async () => { throw new Error("Unexpected provider GET"); }, create: async () => { throw new Error("Unexpected provider POST"); } };
      const service = new MetaTemplateManagementService(f.repository, provider, { info() {}, warn() {}, error() {} } as never);
      // Red reproduction: repaired provider configuration alone cannot recover BLOCKED.
      expect(await service.submitPreparedRegistration(f.row.id)).toEqual({ kind: "busy", code: "NOT_READY_TO_SUBMIT" });
      expect(await f.repository.claim(f.row.id, config.wabaId)).toBeNull();
      const before = await f.repository.load(f.row.id);
      const plan = await f.recovery.plan([f.row.id], "test:operator", proof);
      expect(await f.repository.load(f.row.id)).toEqual(before);
      expect((await f.recovery.recover(plan.manifest)).outcomes[0]?.outcome).toBe("eligible");
      expect(await f.repository.load(f.row.id)).toEqual(before);
      await expect(f.recovery.recover(plan.manifest, { apply: true, digest: "0".repeat(64) })).rejects.toMatchObject({ code: "RECOVERY_DIGEST_MISMATCH" });
      await f.recovery.recover(plan.manifest, { apply: true, digest: plan.digest });
      expect((await f.repository.load(f.row.id))?.submissionState).toBe("READY_TO_SUBMIT");
      const events = await db.whatsAppTemplateMetaEvent.findMany({ where: { registrationId: f.row.id } });
      expect(events).toHaveLength(2);
      const audit = events.find((e) => e.eventType === "PRECLAIM_APP_RECOVERY")!;
      expect(audit.requestDigest).toBe(plan.digest);
      expect(audit.evidence).toMatchObject({ manifest: plan.manifest, previousState: "BLOCKED" });
      expect((await f.recovery.recover(plan.manifest, { apply: true, digest: plan.digest })).outcomes[0]?.outcome).toBe("already-applied");
      expect(await db.whatsAppTemplateMetaEvent.count({ where: { registrationId: f.row.id } })).toBe(2);
      const claim = await f.repository.claim(f.row.id, config.wabaId);
      expect(claim).not.toBeNull();
      expect(await f.repository.claim(f.row.id, config.wabaId)).toBeNull();
      await expect(f.recovery.recover(plan.manifest, { apply: true, digest: plan.digest })).rejects.toMatchObject({ code: "RECOVERY_REPLAY_STATE_CHANGED" });
    });
  });
  it.each(["CREATE_INTENT", "POST_INTENT", "CREATE_RESULT", "RECONCILE_RETRY", "UNKNOWN_EVENT"])("refuses historical %s evidence", async (eventType) => {
    await fixture(async (f, db) => {
      const plan = await f.recovery.plan([f.row.id], "test:operator", proof);
      await db.whatsAppTemplateMetaEvent.create({ data: { eventIdentity: randomUUID(), registrationId: f.row.id,
        wabaId: config.wabaId, source: "BACKGROUND", eventType } });
      await expect(f.recovery.recover(plan.manifest, { apply: true, digest: plan.digest })).rejects.toMatchObject({ code: "RECOVERY_SUBMISSION_EVIDENCE" });
      expect((await f.repository.load(f.row.id))?.submissionState).toBe("BLOCKED");
    });
  });
  it.each([
    { providerTemplateId: "123" }, { lastSubmittedAt: new Date() }, { submissionState: "SUBMISSION_UNKNOWN" },
    { submissionState: "SUBMITTED" }, { failureCode: "META_SAMPLE_INVALID" }, { wabaId: "111111" },
    { providerStatus: "UNKNOWN" }, { lastReconciledAt: new Date() },
  ])("refuses mismatched/uncertain registration %j", async (data) => {
    await fixture(async (f, db) => {
      const plan = await f.recovery.plan([f.row.id], "test:operator", proof);
      await db.whatsAppTemplateMetaRegistration.update({ where: { id: f.row.id }, data });
      await expect(f.recovery.recover(plan.manifest, { apply: true, digest: plan.digest })).rejects.toThrow();
      expect(await db.whatsAppTemplateMetaEvent.count({ where: { registrationId: f.row.id, eventType: "PRECLAIM_APP_RECOVERY" } })).toBe(0);
    });
  });
  it("refuses stale snapshots, source/reviewer changes, missing provenance and trusted configuration changes", async () => {
    await fixture(async (f, db) => {
      const plan = await f.recovery.plan([f.row.id], "test:operator", proof);
      const stale = { ...plan.manifest, entries: [{ ...plan.manifest.entries[0]!, updatedAt: new Date(0).toISOString() }] };
      await expect(f.recovery.recover(stale, { apply: true, digest: fingerprint(stale) })).rejects.toMatchObject({ code: "RECOVERY_SNAPSHOT_CHANGED" });
      const wrongConfig = new MetaPreclaimRecovery(db, async () => ({ ...config, appId: "111" }));
      await expect(wrongConfig.recover(plan.manifest)).rejects.toMatchObject({ code: "RECOVERY_CONFIGURATION_CHANGED" });
      await db.whatsAppTemplateLocale.update({ where: { id: f.locale.id }, data: { reviewedAt: new Date(0) } });
      await expect(f.recovery.recover(plan.manifest)).rejects.toMatchObject({ code: "RECOVERY_SNAPSHOT_CHANGED" });
      await db.whatsAppTemplateLocale.update({ where: { id: f.locale.id }, data: { status: "SOURCE_SAVED" } });
      await expect(f.recovery.recover(plan.manifest)).rejects.toMatchObject({ code: "RECOVERY_SOURCE_NOT_REVIEWED" });
      await db.whatsAppTemplateMetaEvent.deleteMany({ where: { registrationId: f.row.id } });
      await expect(f.recovery.plan([f.row.id], "test:operator", proof)).rejects.toMatchObject({ code: "RECOVERY_SUBMISSION_EVIDENCE" });
    });
  });
  it("requires reviewed English source even when the target translation is reviewed", async () => {
    await fixture(async (f, db) => {
      await db.whatsAppTemplateLocale.update({ where: { id: f.locale.id }, data: { languageTag: "sv", providerLanguageCode: "sv" } });
      await db.whatsAppTemplateMetaRegistration.update({ where: { id: f.row.id }, data: { providerLanguageCode: "sv" } });
      await db.whatsAppTemplateMetaEvent.updateMany({ where: { registrationId: f.row.id }, data: { providerLanguageCode: "sv" } });
      const english = await db.whatsAppTemplateLocale.create({ data: { definitionId: f.definition.id, languageTag: "en", providerLanguageCode: "en", contentHash: "b".repeat(64), status: "SOURCE_SAVED" } });
      await expect(f.recovery.plan([f.row.id], "test:operator", proof)).rejects.toMatchObject({ code: "RECOVERY_SOURCE_NOT_REVIEWED" });
      await db.whatsAppTemplateLocale.update({ where: { id: english.id }, data: { status: "REVIEWED", reviewedAt: new Date(), reviewedByAdminId: f.admin.id } });
      const plan = await f.recovery.plan([f.row.id], "test:operator", proof);
      expect((await f.recovery.recover(plan.manifest)).outcomes[0]?.outcome).toBe("eligible");
    });
  });
  it("serializes competing applies without duplicate transition/audit", async () => {
    await fixture(async (f, db) => {
      const plan = await f.recovery.plan([f.row.id], "test:operator", proof);
      const results = await Promise.allSettled([1, 2].map(() => f.recovery.recover(plan.manifest, { apply: true, digest: plan.digest })));
      expect(results.some((r) => r.status === "fulfilled")).toBe(true);
      expect(await db.whatsAppTemplateMetaEvent.count({ where: { registrationId: f.row.id, eventType: "PRECLAIM_APP_RECOVERY" } })).toBe(1);
      expect((await f.recovery.recover(plan.manifest)).outcomes[0]?.outcome).toBe("already-applied");
    });
  });
  it("rolls back the entire bounded batch when another exact row changed", async () => {
    await fixture(async (first, db) => {
      await fixture(async (second) => {
        const plan = await first.recovery.plan([first.row.id, second.row.id], "test:operator", proof);
        await db.whatsAppTemplateMetaRegistration.update({ where: { id: second.row.id }, data: { failureCode: "DIFFERENT_BLOCK" } });
        await expect(first.recovery.recover(plan.manifest, { apply: true, digest: plan.digest })).rejects.toThrow();
        expect((await first.repository.load(first.row.id))?.submissionState).toBe("BLOCKED");
        expect(await db.whatsAppTemplateMetaEvent.count({ where: { registrationId: { in: [first.row.id, second.row.id] }, eventType: "PRECLAIM_APP_RECOVERY" } })).toBe(0);
      });
    });
  });
  it("refuses a lost CAS and rolls back rather than claiming a successful recovery", async () => {
    await fixture(async (f, db) => {
      const plan = await f.recovery.plan([f.row.id], "test:operator", proof);
      const stale = db.$extends({ query: { whatsAppTemplateMetaRegistration: { updateMany() { return { count: 0 }; } } } });
      const recovery = new MetaPreclaimRecovery(stale as never, async () => config);
      await expect(recovery.recover(plan.manifest, { apply: true, digest: plan.digest })).rejects.toMatchObject({ code: "RECOVERY_CAS_LOST" });
      expect((await f.repository.load(f.row.id))?.submissionState).toBe("BLOCKED");
      expect(await db.whatsAppTemplateMetaEvent.count({ where: { registrationId: f.row.id } })).toBe(1);
    });
  });
  it("rolls back transition when audit persistence fails", async () => {
    await fixture(async (f, db) => {
      const plan = await f.recovery.plan([f.row.id], "test:operator", proof);
      const broken = db.$extends({ query: { whatsAppTemplateMetaEvent: { create() { throw new Error("synthetic audit failure"); } } } });
      const recovery = new MetaPreclaimRecovery(broken as never, async () => config);
      await expect(recovery.recover(plan.manifest, { apply: true, digest: plan.digest })).rejects.toThrow("synthetic audit failure");
      expect((await f.repository.load(f.row.id))?.submissionState).toBe("BLOCKED");
      expect(await db.whatsAppTemplateMetaEvent.count({ where: { registrationId: f.row.id } })).toBe(1);
    });
  });
});
