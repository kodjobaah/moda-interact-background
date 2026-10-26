import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { MetaTemplateRepository } from "../../src/services/meta-template-management/repository.js";
import { MetaTemplateManagementService } from "../../src/services/meta-template-management/service.js";
import { checkFinalTemplateRegistration } from
  "../../src/services/recovery-template-integration/final-template-registration.service.js";
import { WooInitialSendFenceService } from
  "../../src/services/woocommerce-recovery/woo-initial-send-fence.service.js";
import { BG006_HASH, seedApprovedWooTemplate, seedSecondWooTemplatePermit,
  deferred, pausedObservation, failingMetaGet, expectUnadmittedAndUncharged } from
  "./fixtures/arch047-final-template-permit.fixture.js";

const url = process.env.TEST_DATABASE_URL;
const disposable = url && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe : describe.skip;

disposable("ARCH-047 BG003/BG006 SQL permit revocation and replay", () => {
  const clients: PrismaClient[] = [];
  const client = () => {
    const db = new PrismaClient({ datasourceUrl: url! });
    clients.push(db);
    return db;
  };
  afterAll(async () => { await Promise.all(clients.map((db) => db.$disconnect())); });

  it("a BG003 transaction holding the registration update wins; a waiting real permit sees committed UNKNOWN", async () => {
    const observer = client(); const sender = client();
    const seeded = await seedApprovedWooTemplate(observer);
    const fenced = deferred(); const releaseObservation = deferred();
    const permitReachedRegistration = deferred();
    // Only the transaction boundary is instrumented. BG003's actual event
    // insert and registration CAS run on PostgreSQL; no simulated status rows.
    const pausedDatabase = {
      whatsAppTemplateMetaRegistration: observer.whatsAppTemplateMetaRegistration,
      whatsAppTemplateMetaEvent: observer.whatsAppTemplateMetaEvent,
      $transaction: (callback: (tx: unknown) => Promise<unknown>) =>
        observer.$transaction(async (tx) => callback({
          whatsAppTemplateMetaEvent: tx.whatsAppTemplateMetaEvent,
          whatsAppTemplateMetaRegistration: {
            findUnique: tx.whatsAppTemplateMetaRegistration.findUnique.bind(tx.whatsAppTemplateMetaRegistration),
            updateMany: async (args: never) => {
              const result = await tx.whatsAppTemplateMetaRegistration.updateMany(args);
              fenced.resolve();
              await releaseObservation.promise; // BEFORE receipt+status commit
              return result;
            },
          },
        })),
    };
    const observationRepo = new MetaTemplateRepository(pausedDatabase as never);
    const operations: Promise<unknown>[] = [];
    try {
      const observation = observationRepo.recordObservation(pausedObservation(seeded));
      operations.push(observation);
      await fenced.promise;
      const observingSendDb = {
        $transaction: (callback: (tx: unknown) => Promise<unknown>, options: never) =>
          sender.$transaction(async (tx) => callback({
            $queryRaw: tx.$queryRaw.bind(tx),
            $queryRawUnsafe: (sql: string, ...args: unknown[]) => {
              if (sql.includes("FOR SHARE OF v,r,l,d")) permitReachedRegistration.resolve();
              return tx.$queryRawUnsafe(sql, ...args);
            },
          }), options),
      };
      const permit = new WooInitialSendFenceService(observingSendDb as never).admitFinalSend(seeded.input);
      operations.push(permit);
      await permitReachedRegistration.promise;
      expect((await sender.conversationMessage.findUniqueOrThrow({
        where: { id: seeded.input.messageId },
      })).providerDispatchKey).toBeNull();
      releaseObservation.resolve();
      await observation;
      expect(await permit).toEqual({ kind: "suppressed", reason: "TEMPLATE_PROVIDER_STATUS_UNRESOLVED" });
      await expectUnadmittedAndUncharged(sender, seeded);
      const failedGet = failingMetaGet();
      await expect(new MetaTemplateManagementService(new MetaTemplateRepository(observer),
        failedGet.provider as never, failedGet.logger).reconcileRegistration(seeded.registrationId))
        .rejects.toBe(failedGet.failure);
      expect(await sender.whatsAppTemplateMetaEvent.count({ where: {
        registrationId: seeded.registrationId, outcome: "RECONCILIATION_PENDING", processedAt: null,
      } })).toBe(1);
    } finally {
      releaseObservation.resolve();
      await Promise.allSettled(operations);
    }
  }, 60_000);

  it("permit holding registration lock wins first, then BG003 revokes and fences the next distinct permit", async () => {
    const sending = client(); const observing = client();
    const seeded = await seedApprovedWooTemplate(sending);
    const next = await seedSecondWooTemplatePermit(sending, seeded);
    const permitLocked = deferred(); const releasePermit = deferred();
    const bg003UpdateAttempted = deferred();
    const operations: Promise<unknown>[] = [];
    const lockHoldingCheck = async (
      tx: Parameters<typeof checkFinalTemplateRegistration>[0],
      identity: Parameters<typeof checkFinalTemplateRegistration>[1],
      now: Date,
    ) => {
      const denied = await checkFinalTemplateRegistration(tx, identity, now);
      permitLocked.resolve(); // locked exact v,r,l,d, inside SQL permit
      await releasePermit.promise;
      return denied;
    };
    try {
      const first = new WooInitialSendFenceService(sending, undefined, undefined,
        undefined, lockHoldingCheck).admitFinalSend(seeded.input);
      operations.push(first);
      await permitLocked.promise;
      const staleBeforePause = await new MetaTemplateRepository(observing).load(seeded.registrationId);
      expect(staleBeforePause).not.toBeNull();
      const observedDatabase = {
        whatsAppTemplateMetaRegistration: observing.whatsAppTemplateMetaRegistration,
        whatsAppTemplateMetaEvent: observing.whatsAppTemplateMetaEvent,
        $transaction: (callback: (tx: unknown) => Promise<unknown>) =>
          observing.$transaction(async (tx) => callback({
            whatsAppTemplateMetaEvent: tx.whatsAppTemplateMetaEvent,
            whatsAppTemplateMetaRegistration: {
              findUnique: tx.whatsAppTemplateMetaRegistration.findUnique.bind(tx.whatsAppTemplateMetaRegistration),
              updateMany: (args: never) => {
                bg003UpdateAttempted.resolve();
                return tx.whatsAppTemplateMetaRegistration.updateMany(args);
              },
            },
          })),
      };
      const observation = new MetaTemplateRepository(observedDatabase as never)
        .recordObservation(pausedObservation(seeded));
      operations.push(observation);
      await bg003UpdateAttempted.promise; // writer now waits for reader's row lock
      expect((await observing.whatsAppTemplateMetaRegistration.findUniqueOrThrow({
        where: { id: seeded.registrationId },
      })).providerStatus).toBe("APPROVED");
      releasePermit.resolve();
      expect(await first).toEqual({ kind: "admitted" });
      await observation;
      const meta = failingMetaGet();
      await expect(new MetaTemplateManagementService(new MetaTemplateRepository(observing),
        meta.provider as never, meta.logger).reconcileRegistration(seeded.registrationId))
        .rejects.toBe(meta.failure);
      expect((await sending.conversationMessage.findUniqueOrThrow({
        where: { id: seeded.input.messageId },
      })).providerDispatchKey).toMatch(/^arch046-woo-initial-/);
      // A previously acquired permit is irreversible; a distinct second
      // attempt has to re-read the same now-UNKNOWN registration and deny.
      expect(await new WooInitialSendFenceService(observing).admitFinalSend(next.input))
        .toEqual({ kind: "suppressed", reason: "TEMPLATE_PROVIDER_STATUS_UNRESOLVED" });
      expect((await observing.conversationMessage.findUniqueOrThrow({
        where: { id: next.input.messageId },
      })).providerDispatchKey).toBeNull();
      // A GET started before PAUSED cannot race in a stale APPROVED snapshot.
      expect(await new MetaTemplateRepository(observing).recordReconciliation(staleBeforePause!, {
        kind: "found", providerId: seeded.identity.providerTemplateId, status: "APPROVED",
        category: "MARKETING", observedHash: BG006_HASH, drift: false,
      })).toBe(false);
      expect((await observing.whatsAppTemplateMetaRegistration.findUniqueOrThrow({
        where: { id: seeded.registrationId },
      })).providerStatus).toBe("UNKNOWN");
    } finally {
      releasePermit.resolve();
      await Promise.allSettled(operations);
    }
  }, 60_000);
});
