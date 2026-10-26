import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// Exercise the real production entrypoint, due-poller, submission service and
// Prisma repository. Only unrelated workers/readiness and external Meta I/O
// are replaced; processDueRegistrations must NOT be mocked in this test.
const state = vi.hoisted(() => ({
  loaded: null as null | { closeResources: readonly (() => Promise<unknown>)[] },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  verifyWaba: vi.fn(),
  find: vi.fn(),
  create: vi.fn(),
}));

vi.mock("../../src/lib/db.js", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return { default: new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL }) };
});
vi.mock("@modainteract/moda-interact-shared/logging", () => ({
  createLogger: () => state.logger,
}));
vi.mock("../../src/services/meta-template-management/meta-graph.adapter.js", () => ({
  MetaGraphTemplateAdapter: class {
    verifyWaba = state.verifyWaba;
    find = state.find;
    create = state.create;
  },
}));
vi.mock("../../src/runtime/readiness.js", () => ({
  startReadyWorkerProcess: vi.fn(async (options: {
    loadWorkerProcess: () => Promise<{ closeResources: readonly (() => Promise<unknown>)[] }>;
  }) => {
    state.loaded = await options.loadWorkerProcess();
    return async () => undefined;
  }),
}));
vi.mock("../../src/runtime/observability.js", () => ({
  closeWorkerObservability: vi.fn(async () => undefined),
}));
vi.mock("../../src/lib/redis.js", () => ({ connectionRedis: {} }));
vi.mock("../../src/observability/queue-performance.js", () => ({
  startQueuePerformanceTelemetry: () => async () => undefined,
}));
vi.mock("../../src/runtime/background-runtime-config.js", () => ({
  backgroundRuntimeConfigService: { start: vi.fn(async () => undefined), close: vi.fn(async () => undefined) },
}));
vi.mock("../../src/runtime/background-runtime-lease.js", () => ({ backgroundRuntimeLeaseService: {} }));
vi.mock("../../src/runtime/queue-concurrency-controller.js", () => ({
  startQueueConcurrencyController: vi.fn(async () => async () => undefined),
}));
vi.mock("../../src/services/recovery-conversation/start-human-command-dispatcher.js", () => ({
  startHumanCommandDispatcher: vi.fn(async () => async () => undefined),
}));
vi.mock("../../src/entrypoints/resources.js", () => ({
  closeWorkerResources: [async () => undefined],
}));
vi.mock("../../src/workers/whatsapp.worker.js", () => ({
  createWhatsappWorker: () => ({ close: vi.fn(async () => undefined) }),
}));

const url = process.env.TEST_DATABASE_URL;
const disposable = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1" ? describe : describe.skip;

async function eventually(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function seedRegistration(db: PrismaClient, adminId: string, name: string): Promise<{
  definitionId: string;
  registrationId: string;
}> {
  const definition = await db.whatsAppTemplateDefinition.create({ data: {
    kind: "META_RECOVERY", purpose: "INITIAL", offerType: "NO_OFFER",
    providerTemplateName: name, category: "MARKETING", sourceLanguageTag: "en",
    astSchemaVersion: 1, sourceHash: "b".repeat(64), status: "SAVED",
    createdByAdminId: adminId,
  } });
  const locale = await db.whatsAppTemplateLocale.create({ data: {
    definitionId: definition.id, languageTag: "en", providerLanguageCode: "en",
    contentHash: "a".repeat(64), status: "REVIEWED", reviewedAt: new Date(),
    reviewedByAdminId: adminId,
  } });
  const registration = await db.whatsAppTemplateMetaRegistration.create({ data: {
    localeId: locale.id, wabaId: "123456789", providerTemplateName: name,
    providerLanguageCode: "en", category: "MARKETING",
    componentsSnapshot: [{ type: "BODY", text: "You left a basket" }],
    parameterBindingsSnapshot: {}, submittedContentHash: "a".repeat(64),
    submissionState: "READY_TO_SUBMIT",
  } });
  return { definitionId: definition.id, registrationId: registration.id };
}

disposable("ARCH-047-BG003 real messaging startup with PostgreSQL", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts due processing without a manual service call, persists outcome/retry, and cancels repeat polling", async () => {
    const { default: db } = await import("../../src/lib/db.js");
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    const admin = await db.platformAdmin.create({ data: {
      email: `bg003-startup-${suffix}@example.invalid`,
    } });
    const definitionIds: string[] = [];
    let closed = false;
    const stop = async () => {
      if (closed || !state.loaded) return;
      closed = true;
      for (const close of state.loaded.closeResources) await close();
    };
    try {
      const success = await seedRegistration(db, admin.id, `moda_bg003_${suffix}_ok`);
      definitionIds.push(success.definitionId);
      const uncertain = await seedRegistration(db, admin.id, `moda_bg003_${suffix}_retry`);
      definitionIds.push(uncertain.definitionId);

      state.find.mockResolvedValue({ kind: "absent" });
      state.verifyWaba.mockResolvedValue(undefined);
      state.create.mockImplementation(async (input: { name: string }) => {
        if (input.name.endsWith("_retry")) throw new Error("Simulated Meta timeout");
        return { id: "987654321" };
      });
      vi.spyOn(Math, "random").mockReturnValue(0); // 0 ms initial jitter
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const cancelSpy = vi.spyOn(globalThis, "clearTimeout");

      // Importing the real entrypoint is what starts the due timer. No direct
      // submitPreparedRegistration/processDueRegistrations call is made here.
      await import("../../src/entrypoints/messaging.js");
      await eventually(async () => state.loaded !== null, "worker startup");
      await eventually(async () => {
        const [submitted, retry] = await Promise.all([
          db.whatsAppTemplateMetaRegistration.findUnique({ where: { id: success.registrationId } }),
          db.whatsAppTemplateMetaRegistration.findUnique({ where: { id: uncertain.registrationId } }),
        ]);
        return submitted?.submissionState === "SUBMITTED" && retry?.submissionState === "SUBMISSION_UNKNOWN";
      }, "real due registrations to be processed");
      await eventually(async () => timeoutSpy.mock.calls.some(([, milliseconds]) => milliseconds === 60_000),
        "next 60-second poll to be scheduled after the failed cycle");

      const submitted = await db.whatsAppTemplateMetaRegistration.findUniqueOrThrow({
        where: { id: success.registrationId },
      });
      const retry = await db.whatsAppTemplateMetaRegistration.findUniqueOrThrow({
        where: { id: uncertain.registrationId },
      });
      expect(submitted.providerTemplateId).toBe("987654321");
      expect(submitted.providerStatus).toBe("PENDING");
      expect(retry.providerTemplateId).toBeNull();
      expect(retry.nextRetryAt?.getTime()).toBeGreaterThan(Date.now());
      expect(state.create).toHaveBeenCalledTimes(2);
      expect(await db.whatsAppTemplateMetaEvent.count({
        where: { registrationId: success.registrationId, eventType: "CREATE_RESULT" },
      })).toBe(1);
      expect(await db.whatsAppTemplateMetaEvent.count({
        where: { registrationId: uncertain.registrationId, eventType: "CREATE_RESULT" },
      })).toBe(1);
      expect(state.logger.error).toHaveBeenCalledWith("meta.template.due.cycle_failed", expect.any(Object));

      // Simulate the next scheduled tick without waiting one minute or invoking
      // a service method directly. Neither successful nor uncertain create may
      // issue a second POST; the DB state and retry timetable arbitrate this.
      const firstInterval = timeoutSpy.mock.calls.findIndex(([, milliseconds]) => milliseconds === 60_000);
      expect(firstInterval).toBeGreaterThanOrEqual(0);
      const handle = timeoutSpy.mock.results[firstInterval]?.value as ReturnType<typeof setTimeout>;
      clearTimeout(handle);
      const tick = timeoutSpy.mock.calls[firstInterval]?.[0];
      expect(typeof tick).toBe("function");
      if (typeof tick === "function") tick();
      await eventually(async () => timeoutSpy.mock.calls.filter(([, milliseconds]) => milliseconds === 60_000).length >= 2,
        "next poll cycle completion");
      expect(state.create).toHaveBeenCalledTimes(2);

      const nextInterval = timeoutSpy.mock.calls.map(([, milliseconds], index) => ({ index, milliseconds }))
        .filter(({ milliseconds }) => milliseconds === 60_000).at(-1)?.index;
      expect(nextInterval).toBeDefined();
      const finalHandle = timeoutSpy.mock.results[nextInterval!]?.value as ReturnType<typeof setTimeout>;
      await stop();
      expect(cancelSpy).toHaveBeenCalledWith(finalHandle);
      // A stale queued timer callback cannot restart processing after shutdown.
      const finalTick = timeoutSpy.mock.calls[nextInterval!]?.[0];
      if (typeof finalTick === "function") finalTick();
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(state.create).toHaveBeenCalledTimes(2);
    } finally {
      await stop();
      const locales = await db.whatsAppTemplateLocale.findMany({
        where: { definitionId: { in: definitionIds } }, select: { id: true },
      });
      const localeIds = locales.map(({ id }) => id);
      const registrations = await db.whatsAppTemplateMetaRegistration.findMany({
        where: { localeId: { in: localeIds } }, select: { id: true },
      });
      const ids = registrations.map(({ id }) => id);
      await db.whatsAppTemplateMetaEvent.deleteMany({ where: { registrationId: { in: ids } } });
      await db.whatsAppTemplateMetaRegistration.deleteMany({ where: { id: { in: ids } } });
      await db.whatsAppTemplateLocale.deleteMany({ where: { id: { in: localeIds } } });
      await db.whatsAppTemplateDefinition.deleteMany({ where: { id: { in: definitionIds } } });
      await db.platformAdmin.delete({ where: { id: admin.id } });
      await db.$disconnect();
    }
  }, 30_000);
});
