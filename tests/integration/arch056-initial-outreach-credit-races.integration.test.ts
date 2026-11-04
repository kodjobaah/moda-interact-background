import "dotenv/config";
import { Prisma, PrismaClient } from "@prisma/client";
import { createLogger, type LogRecord } from "@modainteract/moda-interact-shared/logging";
import { describe, expect, it } from "vitest";
import { InitialOutreachCreditService } from "../../src/services/recovery-billing/initial-outreach-credit.service.js";
import { RecoveryDeliveryCompensationService } from "../../src/services/recovery-delivery-compensation/reconcile.service.js";
import { WhatsAppProviderStatusService } from "../../src/services/whatsapp-provider-status.service.js";
import { addSharedCounterInitialOutreach, createInitialOutreachCreditFixture } from "./fixtures/arch056-initial-outreach-credit.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe
  : describe.skip;

suite("ARCH-056 initial outreach credit races (PostgreSQL)", () => {
  it("commits two distinct confirmed messages sharing one counter through independent clients", async () => {
    const f = await createInitialOutreachCreditFixture();
    const second = await addSharedCounterInitialOutreach(f);
    const secondClient = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL! });
    try {
      const secondService = new InitialOutreachCreditService(secondClient);
      const firstInput = {
        shopId: f.shopId,
        recoveryId: f.recoveryId,
        outreachAttemptId: f.attemptId,
        outboundMessageId: f.messageId,
      };
      const secondInput = {
        shopId: f.shopId,
        recoveryId: second.recoveryId,
        outreachAttemptId: second.attemptId,
        outboundMessageId: second.messageId,
      };
      const results = await Promise.all([
        f.service.settleConfirmedInitialOutreach(firstInput),
        secondService.settleConfirmedInitialOutreach(secondInput),
      ]);
      expect(results).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "settled", reservationId: f.reservationId }),
        expect.objectContaining({ kind: "settled", reservationId: second.reservationId }),
      ]));
      const counter = await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: f.counterId! } });
      expect(counter).toMatchObject({ committedQuantity: 2, reservedQuantity: 0 });
      const reservations = await f.db.usageReservation.findMany({ where: { id: { in: [f.reservationId!, second.reservationId] } } });
      expect(reservations).toHaveLength(2);
      expect(reservations.every((reservation) => reservation.status === "COMMITTED")).toBe(true);
      expect(await f.db.usageEvent.count({ where: {
        shopId: f.shopId,
        metric: "RECOVERY_CONVERSATION",
        correctionOfUsageEventId: null,
      } })).toBe(2);
    } finally {
      await secondClient.$disconnect();
      await f.close();
    }
  });

  it("correlates the real compensation owner's rollback with the status caller after status commit", async () => {
    const f = await createInitialOutreachCreditFixture();
    const ownerRecords: LogRecord[] = [];
    const statusRecords: LogRecord[] = [];
    const original = new Error("actual compensation source-release failure sentinel");
    await f.db.recoveryOutreachAttempt.update({
      where: { id: f.attemptId },
      data: { status: "WAITING_FOR_RESPONSE" },
    });
    const compensationDatabase = {
      $transaction: (operation: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) => f.db.$transaction(
        (tx) => {
          const transaction = new Proxy(tx, {
            get(target, property, receiver) {
              if (property !== "usageReservation") return Reflect.get(target, property, receiver);
              return new Proxy(target.usageReservation, {
                get(delegate, method, delegateReceiver) {
                  const value = Reflect.get(delegate, method, delegateReceiver);
                  if (method !== "update" || typeof value !== "function") return value;
                  return async (...args: unknown[]) => {
                    await Reflect.apply(value, delegate, args);
                    throw original;
                  };
                },
              });
            },
          });
          return operation(transaction);
        },
        options as never,
      ),
    };
    const compensation = new RecoveryDeliveryCompensationService(
      compensationDatabase as never,
      undefined,
      createLogger({ serviceName: "moda-recovery-worker", environment: "test", sink: (record) => ownerRecords.push(record) }),
    );
    const status = new WhatsAppProviderStatusService(
      f.db as never,
      createLogger({ serviceName: "moda-messaging-worker", environment: "test", sink: (record) => statusRecords.push(record) }),
      3,
      compensation,
      { afterCorrection: async () => "not-applicable" },
      { fromProviderDelivery: async () => "unchanged" },
      { notify: async () => "skipped" },
    );
    try {
      await expect(status.process({
        schemaVersion: 3,
        providerAccountId: "account-1",
        providerPhoneNumberId: "phone-1",
        providerMessageId: f.providerMessageId,
        status: "FAILED",
        occurredAt: new Date().toISOString(),
        failure: { providerCode: "131026" },
      })).rejects.toBe(original);

      const ownerFailure = JSON.parse(JSON.stringify(ownerRecords.find((record) =>
        record.event === "recovery.delivery_compensation.failed"))) as Record<string, unknown>;
      const callerFailure = JSON.parse(JSON.stringify(statusRecords.find((record) =>
        record.event === "whatsapp.provider_status.downstream_failed"))) as Record<string, unknown>;
      expect(ownerFailure).toMatchObject({
        level: "error",
        "service.name": "moda-recovery-worker",
        "deployment.environment.name": "test",
        data: {
          providerMessageId: f.providerMessageId,
          stage: "source_release",
          error: { name: "Error", message: original.message },
        },
      });
      expect(callerFailure).toMatchObject({
        level: "error",
        "service.name": "moda-messaging-worker",
        "deployment.environment.name": "test",
        data: {
          stage: "compensation",
          providerMessageId: f.providerMessageId,
          statusTransactionCommitted: true,
          sourceDiagnosticEvent: "recovery.delivery_compensation.failed",
        },
      });
      expect(callerFailure).not.toHaveProperty("data.error");
      expect(await f.db.conversationMessage.findUniqueOrThrow({ where: { id: f.messageId } }))
        .toMatchObject({ status: "FAILED", providerFailureCode: "131026" });
      expect(await f.db.recoveryOutreachAttempt.findUniqueOrThrow({ where: { id: f.attemptId } }))
        .toMatchObject({ status: "FAILED", failureCode: "WHATSAPP_RECIPIENT_UNDELIVERABLE" });
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId! } }))
        .toMatchObject({ status: "RESERVED" });
      expect(await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: f.counterId! } }))
        .toMatchObject({ reservedQuantity: 1, committedQuantity: 0 });
    } finally {
      await f.close();
    }
  });
});
