import "dotenv/config";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { createLogger, type LogRecord } from "@modainteract/moda-interact-shared/logging";
import { describe, expect, it } from "vitest";
import { InitialOutreachCreditService } from "../../src/services/recovery-billing/initial-outreach-credit.service.js";
import { createInitialOutreachCreditFixture } from "./fixtures/arch056-initial-outreach-credit.fixture.js";

const suite = process.env.TEST_DATABASE_URL && process.env.MODA_DISPOSABLE_INTEGRATION === "1"
  ? describe
  : describe.skip;

suite("ARCH-056 initial outreach credit (PostgreSQL)", () => {
  it.each([
    ["free", "free", "FREE_RECOVERY_RESERVATION"],
    ["paid", "paid", "PAID_RECOVERY_CONVERSATION"],
    ["purchased", "purchased", "PURCHASED_RECOVERY_CREDITS"],
    ["promotional", "promotional", "PROMOTIONAL_RECOVERY_CREDITS"],
  ] as const)("commits the exact %s source and validates its positive event on replay", async (source, sourceKind, usageSourceType) => {
    const f = await createInitialOutreachCreditFixture({ source });
    try {
      const input = {
        shopId: f.shopId,
        recoveryId: f.recoveryId,
        outreachAttemptId: f.attemptId,
        outboundMessageId: f.messageId,
      };
      await expect(f.service.settleConfirmedInitialOutreach(input)).resolves.toMatchObject({
        kind: "settled",
        disposition: "committed",
        sourceKind,
        sourceKey: f.sourceKey,
        reservationId: f.reservationId,
      });
      if (source === "paid") {
        const periodCounter = await f.db.billingPeriodEntitlementCounter.findUniqueOrThrow({ where: { id: f.periodCounterId! } });
        await f.db.billingPeriod.update({ where: { id: periodCounter.billingPeriodId }, data: { status: "CLOSED" } });
      }
      await expect(f.service.settleConfirmedInitialOutreach(input)).resolves.toMatchObject({
        kind: "settled",
        disposition: "already-committed",
        sourceKey: f.sourceKey,
      });
      const reservation = await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId! } });
      const event = await f.db.usageEvent.findUniqueOrThrow({ where: { id: reservation.committedUsageEventId! } });
      expect(reservation).toMatchObject({ status: "COMMITTED", shopId: f.shopId, sourceKey: f.sourceKey, quantity: 1 });
      expect(reservation.committedUsageEventId).toBeTruthy();
      expect(event).toMatchObject({
        shopId: f.shopId,
        metric: "RECOVERY_CONVERSATION",
        sourceType: usageSourceType,
        sourceId: source === "paid" ? f.sourceKey : f.reservationId,
        provider: f.provider,
        idempotencyKey: expect.any(String),
      });
      if (source === "free" || source === "purchased") {
        expect(await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: f.counterId! } }))
          .toMatchObject({ committedQuantity: 1, reservedQuantity: 0 });
      } else if (source === "paid") {
        expect(await f.db.billingPeriodEntitlementCounter.findUniqueOrThrow({ where: { id: f.periodCounterId! } }))
          .toMatchObject({ committedQuantity: 1, reservedQuantity: 0 });
        expect(event.billingPeriodId).toBeTruthy();
      } else {
        expect(await f.db.promotionalCreditGrant.findUniqueOrThrow({ where: { id: f.grantId! } }))
          .toMatchObject({ committedQuantity: 1, reservedQuantity: 0 });
      }
      expect(await f.db.usageEvent.count({ where: { shopId: f.shopId, metric: "RECOVERY_CONVERSATION" } })).toBe(1);
    } finally {
      await f.close();
    }
  });

  it("returns absent only for a null-message attempt with no source evidence", async () => {
    const f = await createInitialOutreachCreditFixture({ withCredit: false });
    try {
      await expect(f.service.revalidateExistingInitialOutreach({
        shopId: f.shopId,
        recoveryId: f.recoveryId,
        outreachAttemptId: f.attemptId,
        outboundMessageId: null,
      })).resolves.toEqual({ kind: "absent" });
    } finally {
      await f.close();
    }
  });


  it("holds null-message absence when an unlinked outbound automated message exists in the recovery conversation", async () => {
    const f = await createInitialOutreachCreditFixture({ withCredit: false });
    try {
      const conversation = await f.db.conversation.findUniqueOrThrow({
        where: { checkoutRecoveryId: f.recoveryId },
        select: { id: true },
      });
      await f.db.conversationMessage.create({ data: {
        conversationId: conversation.id,
        direction: "OUTBOUND",
        senderType: "AUTOMATION",
        status: "PENDING",
        content: "unlinked pending initial message",
      } });

      await expect(f.service.revalidateExistingInitialOutreach({
        shopId: f.shopId,
        recoveryId: f.recoveryId,
        outreachAttemptId: f.attemptId,
        outboundMessageId: null,
      })).resolves.toMatchObject({ kind: "held", reason: "lineage-conflict" });
    } finally {
      await f.close();
    }
  });

  it("holds null-message absence when a merchant command is linked to the initial attempt", async () => {
    const f = await createInitialOutreachCreditFixture({ withCredit: false });
    try {
      const conversation = await f.db.conversation.findUniqueOrThrow({
        where: { checkoutRecoveryId: f.recoveryId },
        select: { id: true },
      });
      const command = await f.db.$transaction(async (tx) => {
        const created = await tx.merchantConversationSendCommand.create({ data: {
          shopId: f.shopId,
          conversationId: conversation.id,
          kind: "RECOVERY_FOLLOW_UP_TEMPLATE",
          recipientSnapshot: "15551234567",
          idempotencyKey: `initial-attempt-command:${f.attemptId}`,
          payloadSha256: "a".repeat(64),
          expectedControlRevision: 0,
          templateName: "recovery_follow_up",
          templateLanguageCode: "en_US",
          recoveryOutreachAttemptId: f.attemptId,
        } });
        return tx.merchantConversationSendCommand.update({
          where: { id: created.id },
          data: {
            state: "CANCELLED", failureCode: "fixture_lineage_only",
            completedAt: new Date(), outboundMessageId: null,
          },
        });
      });

      await expect(f.service.revalidateExistingInitialOutreach({
        shopId: f.shopId,
        recoveryId: f.recoveryId,
        outreachAttemptId: f.attemptId,
        outboundMessageId: null,
      })).resolves.toMatchObject({ kind: "held", reason: "lineage-conflict" });
      await expect(f.db.merchantConversationSendCommand.findUniqueOrThrow({
        where: { id: command.id },
        select: { state: true, outboundMessageId: true, dispatchAttemptCount: true },
      })).resolves.toEqual({ state: "CANCELLED", outboundMessageId: null, dispatchAttemptCount: 0 });
    } finally {
      await f.close();
    }
  });

  it.each(["free", "paid", "purchased", "promotional"] as const)(
    "revalidates the same retained %s source without changing accounting",
    async (source) => {
      const f = await createInitialOutreachCreditFixture({ source });
      try {
        await f.db.conversationMessage.update({
          where: { id: f.messageId },
          data: { status: "PENDING", providerMessageId: null, sentAt: null },
        });
        await f.db.recoveryOutreachAttempt.update({
          where: { id: f.attemptId },
          data: { sentAt: null },
        });
        await f.db.usageEvent.create({ data: {
          shopId: f.shopId,
          metric: "OUTBOUND_AUTOMATED_MESSAGE",
          quantity: 1,
          idempotencyKey: `recovery-outreach:${f.attemptId}`,
          sourceType: "OUTBOUND_AUTOMATED_MESSAGE",
          sourceId: f.messageId,
          provider: f.provider,
        } });

        const reservationBefore = await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId! } });
        const counterBefore = f.counterId
          ? await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: f.counterId } })
          : null;
        const periodCounterBefore = f.periodCounterId
          ? await f.db.billingPeriodEntitlementCounter.findUniqueOrThrow({ where: { id: f.periodCounterId } })
          : null;
        const grantBefore = f.grantId
          ? await f.db.promotionalCreditGrant.findUniqueOrThrow({ where: { id: f.grantId } })
          : null;
        const purchaseBefore = f.purchaseId
          ? await f.db.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: f.purchaseId } })
          : null;
        const usageCountBefore = await f.db.usageEvent.count({ where: { shopId: f.shopId } });

        await expect(f.service.revalidateExistingInitialOutreach({
          shopId: f.shopId,
          recoveryId: f.recoveryId,
          outreachAttemptId: f.attemptId,
          outboundMessageId: f.messageId,
        })).resolves.toMatchObject({
          kind: "admitted",
          admission: { kind: source === "free" ? "lifetime-free" : source, sourceKey: f.sourceKey },
          reservationId: f.reservationId,
        });

        expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId! } })).toEqual(reservationBefore);
        if (counterBefore) expect(await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: f.counterId! } })).toEqual(counterBefore);
        if (periodCounterBefore) expect(await f.db.billingPeriodEntitlementCounter.findUniqueOrThrow({ where: { id: f.periodCounterId! } })).toEqual(periodCounterBefore);
        if (grantBefore) expect(await f.db.promotionalCreditGrant.findUniqueOrThrow({ where: { id: f.grantId! } })).toEqual(grantBefore);
        if (purchaseBefore) expect(await f.db.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: f.purchaseId! } })).toEqual(purchaseBefore);
        expect(await f.db.usageEvent.count({ where: { shopId: f.shopId } })).toBe(usageCountBefore);
      } finally {
        await f.close();
      }
    },
  );

  it.each([
    ["free", "AMBIGUOUS", "reservation-ambiguous"],
    ["free", "RELEASED", "reservation-released"],
    ["paid", "AMBIGUOUS", "reservation-ambiguous"],
    ["paid", "RELEASED", "reservation-released"],
    ["purchased", "AMBIGUOUS", "reservation-ambiguous"],
    ["purchased", "RELEASED", "reservation-released"],
    ["promotional", "AMBIGUOUS", "reservation-ambiguous"],
    ["promotional", "RELEASED", "reservation-released"],
  ] as const)("holds %s %s source without mutation", async (source, status, reason) => {
    const f = await createInitialOutreachCreditFixture({ source });
    try {
      await f.db.usageReservation.update({ where: { id: f.reservationId! }, data: { status } });
      const reservationBefore = await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId! } });
      const counterBefore = f.counterId
        ? await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: f.counterId } })
        : null;
      const periodCounterBefore = f.periodCounterId
        ? await f.db.billingPeriodEntitlementCounter.findUniqueOrThrow({ where: { id: f.periodCounterId } })
        : null;
      const grantBefore = f.grantId
        ? await f.db.promotionalCreditGrant.findUniqueOrThrow({ where: { id: f.grantId } })
        : null;
      const purchaseBefore = f.purchaseId
        ? await f.db.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: f.purchaseId } })
        : null;
      const usageCountBefore = await f.db.usageEvent.count({ where: { shopId: f.shopId } });

      await expect(f.service.settleConfirmedInitialOutreach({
        shopId: f.shopId,
        recoveryId: f.recoveryId,
        outreachAttemptId: f.attemptId,
        outboundMessageId: f.messageId,
      })).resolves.toMatchObject({ kind: "held", reason });

      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId! } })).toEqual(reservationBefore);
      if (counterBefore) expect(await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: f.counterId! } })).toEqual(counterBefore);
      if (periodCounterBefore) expect(await f.db.billingPeriodEntitlementCounter.findUniqueOrThrow({ where: { id: f.periodCounterId! } })).toEqual(periodCounterBefore);
      if (grantBefore) expect(await f.db.promotionalCreditGrant.findUniqueOrThrow({ where: { id: f.grantId! } })).toEqual(grantBefore);
      if (purchaseBefore) expect(await f.db.recoveryCreditPurchase.findUniqueOrThrow({ where: { id: f.purchaseId! } })).toEqual(purchaseBefore);
      expect(await f.db.usageEvent.count({ where: { shopId: f.shopId } })).toBe(usageCountBefore);
    } finally {
      await f.close();
    }
  });

  it("holds a paid RESERVED source after its original period closes without selecting another period", async () => {
    const f = await createInitialOutreachCreditFixture({ source: "paid" });
    try {
      const periodCounter = await f.db.billingPeriodEntitlementCounter.findUniqueOrThrow({ where: { id: f.periodCounterId! } });
      await f.db.billingPeriod.update({ where: { id: periodCounter.billingPeriodId }, data: { status: "CLOSED" } });
      const reservationBefore = await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId! } });
      const counterBefore = await f.db.billingPeriodEntitlementCounter.findUniqueOrThrow({ where: { id: f.periodCounterId! } });

      await expect(f.service.settleConfirmedInitialOutreach({
        shopId: f.shopId,
        recoveryId: f.recoveryId,
        outreachAttemptId: f.attemptId,
        outboundMessageId: f.messageId,
      })).resolves.toMatchObject({ kind: "held", reason: "paid-period-not-current" });

      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId! } })).toEqual(reservationBefore);
      expect(await f.db.billingPeriodEntitlementCounter.findUniqueOrThrow({ where: { id: f.periodCounterId! } })).toEqual(counterBefore);
      expect(await f.db.usageEvent.count({ where: { shopId: f.shopId, metric: "RECOVERY_CONVERSATION" } })).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("rolls back owner counter mutation when the positive usage insert conflicts and emits the original failure", async () => {
    const f = await createInitialOutreachCreditFixture();
    const records: LogRecord[] = [];
    const service = new InitialOutreachCreditService(
      f.db,
      createLogger({ serviceName: "initial-outreach-credit-integration-test", environment: "test", sink: (record) => records.push(record) }),
    );
    try {
      const sourceKey = f.sourceKey!;
      const committedKey = createRecoveryIdempotencyKey(f.shopId, sourceKey);
      await f.db.usageEvent.create({ data: {
        shopId: f.shopId,
        metric: "OUTBOUND_AUTOMATED_MESSAGE",
        quantity: 1,
        idempotencyKey: committedKey,
        sourceType: "OUTBOUND_AUTOMATED_MESSAGE",
        sourceId: "conflicting-source-sentinel",
        provider: f.provider,
      } });
      const counterBefore = await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: f.counterId! } });

      await expect(service.settleConfirmedInitialOutreach({
        shopId: f.shopId,
        recoveryId: f.recoveryId,
        outreachAttemptId: f.attemptId,
        outboundMessageId: f.messageId,
      })).rejects.toMatchObject({ code: "P2002" });

      expect(await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: f.counterId! } })).toEqual(counterBefore);
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId! } }))
        .toMatchObject({ status: "RESERVED", committedUsageEventId: null });
      expect(await f.db.usageEvent.count({ where: { shopId: f.shopId, metric: "RECOVERY_CONVERSATION" } })).toBe(0);
      const failure = JSON.parse(JSON.stringify(records.find((record) => record.event === "recovery.initial_outreach_credit.failed"))) as Record<string, unknown>;
      expect(failure).toMatchObject({
        level: "error",
        "service.name": "initial-outreach-credit-integration-test",
        data: {
          stage: "source_commit",
          shopId: f.shopId,
          recoveryId: f.recoveryId,
          outreachAttemptId: f.attemptId,
          error: { name: "PrismaClientKnownRequestError" },
          databaseError: { code: "P2002" },
        },
      });
    } finally {
      await f.close();
    }
  });

  it("rolls back the inserted positive event when an owner update throws the original exception", async () => {
    const f = await createInitialOutreachCreditFixture();
    const records: LogRecord[] = [];
    const original = new Error("owner update failure after positive event sentinel");
    const database = {
      $transaction: (operation: (tx: never) => Promise<unknown>, options?: object) => f.db.$transaction(
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
          return operation(transaction as never);
        },
        options as never,
      ),
    };
    const service = new InitialOutreachCreditService(
      database as never,
      createLogger({ serviceName: "initial-outreach-credit-integration-test", environment: "test", sink: (record) => records.push(record) }),
    );
    try {
      const counterBefore = await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: f.counterId! } });
      await expect(service.settleConfirmedInitialOutreach({
        shopId: f.shopId,
        recoveryId: f.recoveryId,
        outreachAttemptId: f.attemptId,
        outboundMessageId: f.messageId,
      })).rejects.toBe(original);

      expect(await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: f.counterId! } })).toEqual(counterBefore);
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId! } }))
        .toMatchObject({ status: "RESERVED", committedUsageEventId: null });
      expect(await f.db.usageEvent.count({ where: { shopId: f.shopId, metric: "RECOVERY_CONVERSATION" } })).toBe(0);
      expect(JSON.stringify(records)).toContain("owner update failure after positive event sentinel");
      expect(records.find((record) => record.event === "recovery.initial_outreach_credit.failed"))
        .toMatchObject({ data: { stage: "source_commit", error: { message: original.message } } });
    } finally {
      await f.close();
    }
  });

  it("rolls back owner mutations when final positive verification finds no committed source", async () => {
    const f = await createInitialOutreachCreditFixture();
    const records: LogRecord[] = [];
    let sourceReads = 0;
    const database = {
      $transaction: (operation: (tx: never) => Promise<unknown>, options?: object) => f.db.$transaction(
        (tx) => {
          const transaction = new Proxy(tx, {
            get(target, property, receiver) {
              if (property !== "usageReservation") return Reflect.get(target, property, receiver);
              return new Proxy(target.usageReservation, {
                get(delegate, method, delegateReceiver) {
                  const value = Reflect.get(delegate, method, delegateReceiver);
                  if (method !== "findMany" || typeof value !== "function") return value;
                  return async (...args: unknown[]) => {
                    const rows = await Reflect.apply(value, delegate, args);
                    sourceReads += 1;
                    return sourceReads === 2 ? [] : rows;
                  };
                },
              });
            },
          });
          return operation(transaction as never);
        },
        options as never,
      ),
    };
    const service = new InitialOutreachCreditService(
      database as never,
      createLogger({ serviceName: "initial-outreach-credit-integration-test", environment: "test", sink: (record) => records.push(record) }),
    );
    try {
      const counterBefore = await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: f.counterId! } });
      await expect(service.settleConfirmedInitialOutreach({
        shopId: f.shopId,
        recoveryId: f.recoveryId,
        outreachAttemptId: f.attemptId,
        outboundMessageId: f.messageId,
      })).resolves.toMatchObject({ kind: "held", reason: "settlement-not-committed" });

      expect(sourceReads).toBe(2);
      expect(await f.db.shopEntitlementCounter.findUniqueOrThrow({ where: { id: f.counterId! } })).toEqual(counterBefore);
      expect(await f.db.usageReservation.findUniqueOrThrow({ where: { id: f.reservationId! } }))
        .toMatchObject({ status: "RESERVED", committedUsageEventId: null });
      expect(await f.db.usageEvent.count({ where: { shopId: f.shopId, metric: "RECOVERY_CONVERSATION" } })).toBe(0);
      expect(records.find((record) => record.event === "recovery.initial_outreach_credit.held"))
        .toMatchObject({ data: { stage: "committed_usage_verification", reason: "settlement-not-committed" } });
    } finally {
      await f.close();
    }
  });
});
