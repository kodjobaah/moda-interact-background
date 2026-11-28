import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
  createLogger,
  type LogRecord,
} from "@modainteract/moda-interact-shared/logging";

vi.mock("../../../src/lib/db.js", () => ({ default: {} }));
vi.mock(
  "../../../src/services/recovery-delivery-compensation/reconcile.service.js",
  () => ({
    recoveryDeliveryCompensationService: { reconcile: vi.fn() },
  }),
);
vi.mock("@prisma/client", () => ({
  MessageStatus: {
    PENDING: "PENDING",
    FAILED: "FAILED",
    SENT: "SENT",
    DELIVERED: "DELIVERED",
    READ: "READ",
  },
  Prisma: {
    DbNull: null,
    ConversationMessageUpdateInput: class {},
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code = "";
    },
    TransactionIsolationLevel: { Serializable: "Serializable" },
  },
  UsageMetric: { DELIVERED_WHATSAPP_MESSAGE: "DELIVERED_WHATSAPP_MESSAGE" },
  MerchantConversationSendState: {
    DISPATCH_ADMITTED: "DISPATCH_ADMITTED",
    UNKNOWN: "UNKNOWN",
    SENT: "SENT",
    FAILED: "FAILED",
  },
}));

import { WhatsAppProviderStatusService } from "../../../src/services/whatsapp-provider-status.service.js";

const baseEvent = {
  schemaVersion: 2 as const,
  providerAccountId: "account-1",
  providerPhoneNumberId: "phone-1",
  providerMessageId: "wamid-1",
  status: "DELIVERED" as const,
  occurredAt: "2026-09-08T15:00:00.000Z",
};

function harness(
  status = "SENT",
  attemptStatus: string | null = "WAITING_FOR_RESPONSE",
  commandState: string | null = null,
) {
  const linkedAttempt =
    attemptStatus === null ? null : { id: "attempt-1", status: attemptStatus };
  const linkedCommand =
    commandState === null ? null : { id: "command-1", state: commandState };
  const message = {
    id: "message-1",
    providerMessageId: "wamid-1",
    dispatchProviderAccountId: "account-1",
    dispatchProviderPhoneNumberId: "phone-1",
    direction: "OUTBOUND",
    status,
    sentAt: new Date("2026-09-08T14:59:00.000Z"),
    deliveredAt: null as Date | null,
    readAt: null as Date | null,
    providerFailureCode: null as string | null,
    failedAt: null as Date | null,
    recoveryOutreachAttempt: linkedAttempt,
    merchantSendCommand: linkedCommand,
    conversation: {
      shopId: null,
      checkoutRecovery: { shopId: "shop-1" },
    },
  };
  const usageEvents: Array<Record<string, unknown>> = [];
  const transaction = {
    $queryRaw: vi.fn(async () => [{ id: "shop-1" }]),
    conversationMessage: {
      findUnique: vi
        .fn()
        .mockImplementation(
          async ({
            where,
          }: {
            where: { id?: string; providerMessageId?: string };
          }) =>
            (!where.id || where.id === message.id) &&
            (!where.providerMessageId ||
              where.providerMessageId === message.providerMessageId)
              ? message
              : null,
        ),
      updateMany: vi
        .fn()
        .mockImplementation(
          async ({
            where,
            data,
          }: {
            where: { id: string; direction: string; status: string };
            data: Record<string, unknown>;
          }) => {
            if (
              where.id !== message.id ||
              where.direction !== message.direction ||
              where.status !== message.status
            ) {
              return { count: 0 };
            }
            Object.assign(message, data);
            return { count: 1 };
          },
        ),
    },
    recoveryBasketRoutingTurn: {
      findUnique: vi.fn(async () => null as Record<string, unknown> | null),
      update: vi.fn(async () => ({})),
    },
    recoveryOutreachRetryIntent: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    recoveryOutreachAttempt: {
      updateMany: vi
        .fn()
        .mockImplementation(
          async ({
            where,
            data,
          }: {
            where: { id: string; status: string };
            data: Record<string, unknown>;
          }) => {
            if (
              !linkedAttempt ||
              where.id !== linkedAttempt.id ||
              where.status !== linkedAttempt.status
            )
              return { count: 0 };
            Object.assign(linkedAttempt, data);
            return { count: 1 };
          },
        ),
    },
    merchantConversationSendCommand: {
      updateMany: vi
        .fn()
        .mockImplementation(
          async ({
            where,
            data,
          }: {
            where: { id: string; state: { in: string[] } };
            data: Record<string, unknown>;
          }) => {
            if (
              !linkedCommand ||
              where.id !== linkedCommand.id ||
              !where.state.in.includes(linkedCommand.state)
            )
              return { count: 0 };
            Object.assign(linkedCommand, data);
            return { count: 1 };
          },
        ),
    },
    usageEvent: {
      upsert: vi
        .fn()
        .mockImplementation(
          async ({ create }: { create: Record<string, unknown> }) => {
            if (
              !usageEvents.some(
                (event) => event.idempotencyKey === create.idempotencyKey,
              )
            ) {
              usageEvents.push(create);
            }
            return create;
          },
        ),
    },
  };
  const database = {
    shop: {
      findUnique: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "provider status must not resolve Shop execution eligibility",
          ),
        ),
    },
    $transaction: vi
      .fn()
      .mockImplementation(
        async (operation: (client: typeof transaction) => unknown) =>
          operation(transaction),
      ),
  };
  const compensation = { reconcile: vi.fn().mockResolvedValue("not-recovery") };
  const failureReachability = {
    afterCorrection: vi.fn().mockResolvedValue("not-applicable"),
  };
  const positiveReachability = {
    fromProviderDelivery: vi.fn().mockResolvedValue("unchanged"),
  };
  const notification = { notify: vi.fn().mockResolvedValue("skipped") };
  const records: LogRecord[] = [];
  const serviceLogger = createLogger({
    serviceName: "provider-status-test",
    environment: "test",
    sink: (record) => records.push(record),
  });

  return {
    message,
    linkedAttempt,
    linkedCommand,
    usageEvents,
    transaction,
    database,
    serviceLogger,
    records,
    compensation,
    failureReachability,
    positiveReachability,
    notification,
    service: new WhatsAppProviderStatusService(
      database as never,
      serviceLogger as never,
      3,
      compensation,
      failureReachability,
      positiveReachability,
      notification,
    ),
  };
}

function statusTransactionError(code: string, message: string) {
  return Object.assign(
    new Prisma.PrismaClientKnownRequestError(message, {
      code,
      clientVersion: "6.19.3",
    }),
    { code, clientVersion: "6.19.3" },
  );
}

describe("WhatsAppProviderStatusService transaction resilience", () => {
  it.each([
    ["P2028", "Transaction already closed: expired transaction"],
    ["P2028", "Transaction not found"],
    ["P2034", "Serialization conflict"],
  ])(
    "restarts a fresh status transaction after %s (%s)",
    async (code, message) => {
      const test = harness();
      const original = statusTransactionError(code, message);
      const expiredRead = vi.fn().mockRejectedValue(original);
      test.database.$transaction.mockImplementationOnce(async (operation) =>
        operation({
          ...test.transaction,
          conversationMessage: {
            ...test.transaction.conversationMessage,
            findUnique: expiredRead,
          },
        }),
      );
      const event = {
        ...baseEvent,
        status: "FAILED" as const,
        schemaVersion: 3 as const,
        failure: { providerCode: "131049" },
      };
      await expect(test.service.process(event)).resolves.toBe("applied");
      expect(test.database.$transaction).toHaveBeenCalledTimes(2);
      for (const call of test.database.$transaction.mock.calls) {
        expect(call[1]).toEqual({
          isolationLevel: "Serializable",
          timeout: 15_000,
        });
      }
      expect(expiredRead).toHaveBeenCalledTimes(1);
      expect(
        test.transaction.conversationMessage.findUnique,
      ).toHaveBeenCalledTimes(2);
      expect(test.message.status).toBe("FAILED");
      expect(test.compensation.reconcile).toHaveBeenCalledExactlyOnceWith(
        "wamid-1",
      );
      expect(test.notification.notify).toHaveBeenCalledTimes(1);
      const retry = test.records.find(
        (record) => record.event === "whatsapp.provider_status.retry",
      );
      expect(JSON.parse(JSON.stringify(retry))).toMatchObject({
        data: {
          attempt: 1,
          maxAttempts: 3,
          retryExhausted: false,
          reasonCode: code,
          error: { message },
          databaseError: { code },
        },
      });
      expect(
        test.records.filter(
          (record) => record.event === "whatsapp.provider_status.applied",
        ),
      ).toHaveLength(1);
    },
  );

  it("restarts after an expired commit without emitting premature success", async () => {
    const test = harness();
    const original = statusTransactionError(
      "P2028",
      "Transaction already closed at commit",
    );
    const before = { ...test.message };
    test.database.$transaction.mockImplementationOnce(async (operation) => {
      await operation(test.transaction);
      expect(
        test.records.some(
          (record) => record.event === "whatsapp.provider_status.applied",
        ),
      ).toBe(false);
      expect(
        test.positiveReachability.fromProviderDelivery,
      ).not.toHaveBeenCalled();
      // The mock is not a database; explicitly restore the rolled-back writes.
      Object.assign(test.message, before);
      test.usageEvents.length = 0;
      throw original;
    });
    await expect(test.service.process(baseEvent)).resolves.toBe("applied");
    expect(test.database.$transaction).toHaveBeenCalledTimes(2);
    expect(test.message.status).toBe("DELIVERED");
    expect(test.usageEvents).toHaveLength(1);
    expect(
      test.positiveReachability.fromProviderDelivery,
    ).toHaveBeenCalledExactlyOnceWith("wamid-1");
    expect(
      test.records.filter(
        (record) => record.event === "whatsapp.provider_status.applied",
      ),
    ).toHaveLength(1);
  });

  it("stops at three attempts, logs exhaustion and preserves the last Prisma error", async () => {
    const test = harness();
    const first = statusTransactionError("P2028", "Transaction not found");
    const last = statusTransactionError(
      "P2028",
      "Transaction expired on final attempt",
    );
    test.database.$transaction
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(last);
    await expect(test.service.process(baseEvent)).rejects.toBe(last);
    expect(test.database.$transaction).toHaveBeenCalledTimes(3);
    expect(
      test.records.filter(
        (record) => record.event === "whatsapp.provider_status.retry",
      ),
    ).toHaveLength(2);
    const failed = test.records.find(
      (record) => record.event === "whatsapp.provider_status.failed",
    );
    expect(JSON.parse(JSON.stringify(failed))).toMatchObject({
      data: {
        attempt: 3,
        maxAttempts: 3,
        retryExhausted: true,
        error: { message: last.message },
        databaseError: { code: "P2028" },
      },
    });
    expect(
      test.records.some(
        (record) => record.event === "whatsapp.provider_status.applied",
      ),
    ).toBe(false);
    expect(
      test.positiveReachability.fromProviderDelivery,
    ).not.toHaveBeenCalled();
    expect(test.compensation.reconcile).not.toHaveBeenCalled();
  });

  it("does not internally retry a different database error", async () => {
    const test = harness();
    const original = statusTransactionError(
      "P2003",
      "Foreign key constraint failed",
    );
    test.database.$transaction.mockRejectedValue(original);
    await expect(test.service.process(baseEvent)).rejects.toBe(original);
    expect(test.database.$transaction).toHaveBeenCalledTimes(1);
    expect(
      test.records.some(
        (record) => record.event === "whatsapp.provider_status.retry",
      ),
    ).toBe(false);
  });

  it("does not repeat a committed status transaction for downstream P2028", async () => {
    const test = harness();
    const original = statusTransactionError(
      "P2028",
      "Downstream transaction expired",
    );
    test.compensation.reconcile.mockRejectedValueOnce(original);
    const event = { ...baseEvent, status: "FAILED" as const };
    await expect(test.service.process(event)).rejects.toBe(original);
    expect(test.database.$transaction).toHaveBeenCalledTimes(1);
    expect(
      test.records.some(
        (record) =>
          record.event === "whatsapp.provider_status.downstream_failed",
      ),
    ).toBe(true);
    expect(
      test.records.some(
        (record) => record.event === "whatsapp.provider_status.retry",
      ),
    ).toBe(false);
    // The outer provider-status job can replay the durable failure safely.
    await expect(test.service.process(event)).resolves.toBe("ignored");
    expect(test.compensation.reconcile).toHaveBeenCalledTimes(2);
    expect(test.notification.notify).toHaveBeenCalledTimes(1);
  });
});

describe("WhatsAppProviderStatusService", () => {
  it("does not emit applied when the status transaction fails at commit", async () => {
    const test = harness();
    const original = Object.assign(new Error("status commit failed"), {
      meta: { code: "40001", query: "unsafe-status-query-sentinel" },
    });
    test.database.$transaction.mockImplementationOnce(async (operation) => {
      await operation(test.transaction);
      throw original;
    });

    await expect(test.service.process(baseEvent)).rejects.toBe(original);
    const emitted = JSON.stringify(test.records);
    expect(emitted).toContain("whatsapp.provider_status.failed");
    expect(emitted).toContain("status commit failed");
    expect(emitted).not.toContain("whatsapp.provider_status.applied");
    expect(emitted).toContain('"databaseError":{"meta":{"code":"40001"}}');
    expect(emitted).not.toContain("unsafe-status-query-sentinel");
    expect(emitted).not.toContain('"providerCode"');
  });

  it("marks continuation failures as occurring after committed status persistence", async () => {
    const test = harness();
    const original = new Error("compensation-source-failure-sentinel");
    test.compensation.reconcile.mockRejectedValueOnce(original);

    await expect(
      test.service.process({
        ...baseEvent,
        status: "FAILED",
        schemaVersion: 3,
        failure: { providerCode: "131026" },
      }),
    ).rejects.toBe(original);
    const emitted = JSON.stringify(test.records);
    expect(emitted).toContain("whatsapp.provider_status.applied");
    expect(emitted).toContain("whatsapp.provider_status.downstream_failed");
    expect(emitted).toContain('"statusTransactionCommitted":true');
    expect(emitted).toContain(
      '"sourceDiagnosticEvent":"recovery.delivery_compensation.failed"',
    );
    expect(emitted).toContain('"providerMessageId":"wamid-1"');
    expect(emitted).not.toContain("compensation-source-failure-sentinel");
    const downstream = JSON.parse(
      JSON.stringify(
        test.records.find(
          (record) =>
            record.event === "whatsapp.provider_status.downstream_failed",
        ),
      ),
    ) as Record<string, unknown>;
    expect(downstream).toMatchObject({
      level: "error",
      "service.name": "provider-status-test",
      "deployment.environment.name": "test",
      data: {
        stage: "compensation",
        providerMessageId: "wamid-1",
        statusTransactionCommitted: true,
        sourceDiagnosticEvent: "recovery.delivery_compensation.failed",
      },
    });
    expect(downstream).not.toHaveProperty("data.error");
  });

  it.each([
    ["failure_reachability", "reachability failure sentinel"],
    ["merchant_notification", "notification failure sentinel"],
  ])(
    "correlates %s failures to committed provider status",
    async (stage, message) => {
      const test = harness();
      const original = new Error(message);
      if (stage === "failure_reachability")
        test.failureReachability.afterCorrection.mockRejectedValueOnce(
          original,
        );
      else test.notification.notify.mockRejectedValueOnce(original);

      await expect(
        test.service.process({
          ...baseEvent,
          status: "FAILED",
          schemaVersion: 3,
          failure: { providerCode: "131026" },
        }),
      ).rejects.toBe(original);

      const events = test.records.map(
        (record) =>
          JSON.parse(JSON.stringify(record)) as Record<string, unknown>,
      );
      expect(
        events.some(
          (record) => record.event === "whatsapp.provider_status.applied",
        ),
      ).toBe(true);
      const downstream = events.find(
        (record) =>
          record.event === "whatsapp.provider_status.downstream_failed",
      );
      expect(downstream).toMatchObject({
        level: "error",
        data: {
          stage,
          providerMessageId: "wamid-1",
          statusTransactionCommitted: true,
          error: { name: "Error", message },
        },
      });
      expect(JSON.stringify(downstream)).not.toContain('"databaseError"');
      expect(test.message.status).toBe("FAILED");
    },
  );

  it("records one delivered usage event for duplicate delivery notifications", async () => {
    const test = harness();

    await test.service.process(baseEvent);
    await test.service.process(baseEvent);

    expect(test.message.status).toBe("DELIVERED");
    expect(test.message.deliveredAt).toEqual(new Date(baseEvent.occurredAt));
    expect(test.usageEvents).toHaveLength(1);
    expect(test.usageEvents[0]).toMatchObject({
      shopId: "shop-1",
      metric: "DELIVERED_WHATSAPP_MESSAGE",
      shopifyReportState: "NOT_APPLICABLE",
    });
  });

  it("treats READ as delivered and preserves the stronger final state", async () => {
    const test = harness();

    await test.service.process({ ...baseEvent, status: "READ" });
    await test.service.process({ ...baseEvent, status: "DELIVERED" });

    expect(test.message.status).toBe("READ");
    expect(test.message.deliveredAt).toEqual(new Date(baseEvent.occurredAt));
    expect(test.message.readAt).toEqual(new Date(baseEvent.occurredAt));
    expect(test.usageEvents).toHaveLength(1);
  });

  it("does not regress delivered or read messages when FAILED arrives late", async () => {
    const test = harness();

    await test.service.process(baseEvent);
    await test.service.process({ ...baseEvent, status: "READ" });
    await test.service.process({ ...baseEvent, status: "FAILED" });

    expect(test.message.status).toBe("READ");
    expect(test.usageEvents).toHaveLength(1);
  });

  it("updates a sent message to FAILED but allows a later delivered status", async () => {
    const test = harness();

    await test.service.process({
      ...baseEvent,
      schemaVersion: 3 as const,
      status: "FAILED" as const,
      failure: { providerCode: "131026" },
    });
    expect(test.message.status).toBe("FAILED");
    expect(test.linkedAttempt?.status).toBe("FAILED");

    test.transaction.recoveryOutreachRetryIntent.updateMany.mockResolvedValueOnce(
      { count: 1 },
    );
    await test.service.process(baseEvent);
    expect(test.message.status).toBe("DELIVERED");
    expect(test.linkedAttempt?.status).toBe("FAILED");
    expect(test.usageEvents).toHaveLength(1);
    expect(
      test.transaction.recoveryOutreachRetryIntent.updateMany,
    ).toHaveBeenCalledExactlyOnceWith({
      where: { failedMessageId: test.message.id, cancelledAt: null },
      data: { cancelledAt: new Date(baseEvent.occurredAt) },
    });
    await test.service.process(baseEvent);
    expect(
      test.transaction.recoveryOutreachRetryIntent.updateMany,
    ).toHaveBeenCalledTimes(1);
    const cancellations = test.records.filter(
      (record) => record.event === "recovery.delivery_retry.cancelled",
    );
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]).toMatchObject({
      level: "info",
      data: {
        shopId: "shop-1",
        failedMessageId: "message-1",
        failedAttemptId: "attempt-1",
        providerMessageId: "wamid-1",
        reason: "late-positive-delivery",
        count: 1,
      },
    });
  });

  it("does not resurrect FAILED with a late SENT and stores v3 failure evidence", async () => {
    const test = harness();
    const failedEvent = {
      ...baseEvent,
      schemaVersion: 3 as const,
      status: "FAILED" as const,
      failure: { providerCode: " 131026 " },
    };

    await test.service.process(failedEvent);
    const failedAt = test.message.failedAt;
    await expect(
      test.service.process({ ...baseEvent, status: "SENT" }),
    ).resolves.toBe("ignored");

    expect(test.message.status).toBe("FAILED");
    expect(test.message.sentAt).toEqual(new Date("2026-09-08T14:59:00.000Z"));
    expect(test.message.providerFailureCode).toBe("131026");
    expect(test.message.failedAt).toEqual(new Date(baseEvent.occurredAt));
    expect(failedAt).toEqual(test.message.failedAt);
  });

  it("fails the exact linked waiting attempt for terminal recipient code 131026", async () => {
    const test = harness();

    await expect(
      test.service.process({
        ...baseEvent,
        schemaVersion: 3 as const,
        status: "FAILED" as const,
        failure: { providerCode: "131026" },
      }),
    ).resolves.toBe("applied");

    expect(test.message.status).toBe("FAILED");
    expect(test.message.providerFailureCode).toBe("131026");
    expect(test.linkedAttempt).toMatchObject({
      id: "attempt-1",
      status: "FAILED",
    });
    expect(
      test.transaction.recoveryOutreachAttempt.updateMany,
    ).toHaveBeenCalledWith({
      where: { id: "attempt-1", status: "WAITING_FOR_RESPONSE" },
      data: {
        status: "FAILED",
        failureCode: "WHATSAPP_RECIPIENT_UNDELIVERABLE",
        followUpDueAt: null,
        closedAt: new Date(baseEvent.occurredAt),
      },
    });
  });

  it.each([
    "NO_RESPONSE",
    "ENGAGED",
    "CANCELLED",
    "CAPACITY_BLOCKED",
    "FAILED",
  ])(
    "preserves an already-converged %s attempt for late 131026 evidence",
    async (attemptStatus) => {
      const test = harness("SENT", attemptStatus);

      await test.service.process({
        ...baseEvent,
        schemaVersion: 3 as const,
        status: "FAILED" as const,
        failure: { providerCode: "131026" },
      });

      expect(test.linkedAttempt?.status).toBe(attemptStatus);
      expect(
        test.transaction.recoveryOutreachAttempt.updateMany,
      ).not.toHaveBeenCalled();
      expect(test.message.providerFailureCode).toBe("131026");
    },
  );

  it.each(["131047", "131049", "999999"])(
    "converges definitive provider failure %s",
    async (providerCode) => {
      const test = harness();
      const event = {
        ...baseEvent,
        schemaVersion: 3 as const,
        status: "FAILED" as const,
        failure: { providerCode },
      };
      await expect(test.service.process(event)).resolves.toBe("applied");
      await expect(test.service.process(event)).resolves.toBe("ignored");
      expect(test.linkedAttempt).toMatchObject({
        status: "FAILED",
        failureCode: `WHATSAPP_DELIVERY_FAILED:${providerCode}`,
        followUpDueAt: null,
      });
      expect(
        test.transaction.recoveryOutreachAttempt.updateMany,
      ).toHaveBeenCalledOnce();
      expect(test.compensation.reconcile).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["DELIVERED", "READ"] as const)(
    "does not let positive %s evidence trigger terminal attempt convergence",
    async (status) => {
      const test = harness(status);

      await test.service.process({
        ...baseEvent,
        schemaVersion: 3 as const,
        status: "FAILED" as const,
        failure: { providerCode: "131026" },
      });

      expect(test.message.status).toBe(status);
      expect(test.linkedAttempt?.status).toBe("WAITING_FOR_RESPONSE");
      expect(
        test.transaction.recoveryOutreachAttempt.updateMany,
      ).not.toHaveBeenCalled();
    },
  );

  it("reinvokes compensation outside the status transaction on a failed replay", async () => {
    const test = harness("SENT", "NO_RESPONSE");
    const failure = {
      ...baseEvent,
      schemaVersion: 3 as const,
      status: "FAILED" as const,
      failure: { providerCode: "131026" },
    };
    test.compensation.reconcile.mockImplementation(async () => {
      expect(test.database.$transaction).toHaveBeenCalledTimes(
        test.compensation.reconcile.mock.calls.length,
      );
      expect(test.message.status).toBe("FAILED");
      return "restored-spendable";
    });
    await test.service.process(failure);
    await test.service.process(failure);
    expect(test.compensation.reconcile).toHaveBeenCalledTimes(2);
    expect(test.compensation.reconcile).toHaveBeenCalledWith("wamid-1");
  });

  it("propagates a post-status compensation failure for provider-job retry", async () => {
    const test = harness("SENT", "NO_RESPONSE");
    const failure = {
      ...baseEvent,
      schemaVersion: 3 as const,
      status: "FAILED" as const,
      failure: { providerCode: "131026" },
    };
    test.compensation.reconcile.mockRejectedValueOnce(
      new Error("ledger not available"),
    );
    await expect(test.service.process(failure)).rejects.toThrow(
      "ledger not available",
    );
    expect(test.message.status).toBe("FAILED");
    await expect(test.service.process(failure)).resolves.toBe("ignored");
    expect(test.compensation.reconcile).toHaveBeenCalledTimes(2);
  });

  it("does not call compensation for positive delivery evidence", async () => {
    const test = harness("FAILED", "FAILED");
    test.message.providerFailureCode = "131026";
    await test.service.process(baseEvent);
    expect(test.message.status).toBe("DELIVERED");
    expect(test.compensation.reconcile).not.toHaveBeenCalled();
  });

  it("records v2 failure time without fabricating a provider code", async () => {
    const test = harness("PENDING");

    await test.service.process({ ...baseEvent, status: "FAILED" });

    expect(test.message.status).toBe("FAILED");
    expect(test.message.failedAt).toEqual(new Date(baseEvent.occurredAt));
    expect(test.message.providerFailureCode).toBeNull();
    expect(test.linkedAttempt).toMatchObject({
      status: "FAILED",
      failureCode: "WHATSAPP_DELIVERY_FAILED",
    });
  });

  it("enriches null failure evidence idempotently on a replayed v3 FAILED", async () => {
    const test = harness();
    const v2Failure = { ...baseEvent, status: "FAILED" as const };
    const v3Failure = {
      ...v2Failure,
      schemaVersion: 3 as const,
      failure: { providerCode: "131026" },
    };

    await test.service.process(v2Failure);
    const failedAt = test.message.failedAt;
    await expect(test.service.process(v3Failure)).resolves.toBe("applied");
    await test.service.process({
      ...v3Failure,
      failure: { providerCode: "different-code" },
    });

    expect(test.message.failedAt).toEqual(failedAt);
    expect(test.message.providerFailureCode).toBe("131026");
    expect(test.message.status).toBe("FAILED");
    expect(
      test.transaction.recoveryOutreachAttempt.updateMany,
    ).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["DELIVERED", "SENT"],
    ["READ", "SENT"],
    ["DELIVERED", "FAILED"],
    ["READ", "FAILED"],
  ] as const)(
    "ignores late %s -> %s evidence",
    async (currentStatus, eventStatus) => {
      const test = harness(currentStatus);

      await expect(
        test.service.process({ ...baseEvent, status: eventStatus }),
      ).resolves.toBe("ignored");

      expect(test.message.status).toBe(currentStatus);
      expect(
        test.transaction.conversationMessage.updateMany,
      ).not.toHaveBeenCalled();
    },
  );

  it("bounds unknown and invalid events without touching durable state", async () => {
    const test = harness();

    await expect(
      test.service.process({ ...baseEvent, providerMessageId: "" }),
    ).resolves.toBe("invalid");
    test.transaction.conversationMessage.findUnique.mockResolvedValueOnce(null);
    await expect(test.service.process(baseEvent)).resolves.toBe(
      "unknown-message",
    );

    expect(
      test.transaction.conversationMessage.updateMany,
    ).not.toHaveBeenCalled();
    expect(test.transaction.usageEvent.upsert).not.toHaveBeenCalled();
  });

  it("stores only bounded accepted provider metadata on delivered usage", async () => {
    const test = harness();

    await test.service.process({
      ...baseEvent,
      pricing: { billable: true, category: "utility", model: "CBP" },
    });

    expect(test.usageEvents[0]?.providerResponseSummary).toBe(
      JSON.stringify({
        providerAccountId: "account-1",
        providerPhoneNumberId: "phone-1",
        status: "DELIVERED",
        pricing: { billable: true, category: "utility", model: "CBP" },
      }),
    );
  });

  it("ignores an inbound message with a matching provider id", async () => {
    const test = harness();
    test.message.direction = "INBOUND";

    await expect(test.service.process(baseEvent)).resolves.toBe("ignored");

    expect(test.message.status).toBe("SENT");
    expect(test.usageEvents).toHaveLength(0);
    expect(
      test.transaction.conversationMessage.updateMany,
    ).not.toHaveBeenCalled();
  });

  it("refuses foreign provider identities before accounting for the durable shop", async () => {
    const test = harness();
    test.message.conversation = {
      shopId: "durable-shop",
      checkoutRecovery: null,
    };

    await test.service.process({
      ...baseEvent,
      providerAccountId: "other-shop-account",
      providerPhoneNumberId: "other-shop-phone",
    });

    expect(test.usageEvents).toHaveLength(0);
    expect(
      test.transaction.conversationMessage.updateMany,
    ).not.toHaveBeenCalled();
    expect(test.compensation.reconcile).not.toHaveBeenCalled();
    expect(test.failureReachability.afterCorrection).not.toHaveBeenCalled();
    expect(
      test.positiveReachability.fromProviderDelivery,
    ).not.toHaveBeenCalled();
    expect(test.notification.notify).not.toHaveBeenCalled();
  });

  it("derives matching-sender accounting from the durable message shop", async () => {
    const test = harness();
    test.message.conversation = {
      shopId: "durable-shop",
      checkoutRecovery: null,
    };

    await expect(test.service.process(baseEvent)).resolves.toBe("applied");

    expect(test.usageEvents[0]).toMatchObject({ shopId: "durable-shop" });
  });

  it.each(["FAILED", "DELIVERED", "READ"] as const)(
    "does not infer ownership for a NULL-stamped %s receipt",
    async (status) => {
      const test = harness();
      Object.assign(test.message, {
        dispatchProviderAccountId: null,
        dispatchProviderPhoneNumberId: null,
      });

      await expect(
        test.service.process({ ...baseEvent, status }),
      ).resolves.toBe("ignored");

      expect(test.usageEvents).toHaveLength(0);
      expect(
        test.transaction.conversationMessage.updateMany,
      ).not.toHaveBeenCalled();
      expect(test.compensation.reconcile).not.toHaveBeenCalled();
      expect(test.failureReachability.afterCorrection).not.toHaveBeenCalled();
      expect(
        test.positiveReachability.fromProviderDelivery,
      ).not.toHaveBeenCalled();
      expect(test.notification.notify).not.toHaveBeenCalled();
    },
  );

  it("finalizes an existing outbound message after its shop becomes inactive without an execution gate lookup", async () => {
    const test = harness();

    await expect(
      test.service.process({ ...baseEvent, status: "READ" }),
    ).resolves.toBe("applied");

    expect(test.message.status).toBe("READ");
    expect(test.usageEvents).toHaveLength(1);
    expect(test.transaction.conversationMessage.updateMany).toHaveBeenCalled();
    expect(test.database.shop.findUnique).not.toHaveBeenCalled();
  });

  it("retries a CAS loser so concurrent READ and DELIVERED remain monotonic", async () => {
    const test = harness();
    let updateAttempts = 0;
    const originalUpdateMany = test.transaction.conversationMessage.updateMany;
    test.transaction.conversationMessage.updateMany = vi
      .fn()
      .mockImplementation(async (args) => {
        updateAttempts += 1;
        if (updateAttempts === 1) {
          Object.assign(test.message, lifecycleDataFor("DELIVERED"));
          test.usageEvents.push({
            idempotencyKey: "whatsapp-delivered:message-1",
          });
        }
        return originalUpdateMany(args);
      });

    await Promise.all([
      test.service.process({ ...baseEvent, status: "READ" }),
      test.service.process(baseEvent),
    ]);

    expect(test.message.status).toBe("READ");
    expect(test.usageEvents).toHaveLength(1);
    expect(updateAttempts).toBeGreaterThanOrEqual(2);
  });

  it("does not let a concurrent FAILED status regress delivery", async () => {
    const test = harness();
    let updateAttempts = 0;
    const originalUpdateMany = test.transaction.conversationMessage.updateMany;
    test.transaction.conversationMessage.updateMany = vi
      .fn()
      .mockImplementation(async (args) => {
        updateAttempts += 1;
        if (updateAttempts === 1) {
          Object.assign(test.message, lifecycleDataFor("DELIVERED"));
          test.usageEvents.push({
            idempotencyKey: "whatsapp-delivered:message-1",
          });
        }
        return originalUpdateMany(args);
      });

    await Promise.all([
      test.service.process(baseEvent),
      test.service.process({ ...baseEvent, status: "FAILED" }),
    ]);

    expect(test.message.status).toBe("DELIVERED");
    expect(test.usageEvents).toHaveLength(1);
  });

  it("converges a HUMAN command from DISPATCH_ADMITTED when SENT receipt arrives", async () => {
    const test = harness("SENT", null, "DISPATCH_ADMITTED");

    await expect(
      test.service.process({ ...baseEvent, status: "SENT" }),
    ).resolves.toBe("applied");

    expect(test.linkedCommand).toMatchObject({
      id: "command-1",
      state: "SENT",
    });
    expect(
      test.transaction.merchantConversationSendCommand.updateMany,
    ).toHaveBeenCalledWith({
      where: {
        id: "command-1",
        state: { in: ["DISPATCH_ADMITTED", "UNKNOWN"] },
      },
      data: { state: "SENT", completedAt: new Date(baseEvent.occurredAt) },
    });
  });

  it("converges an UNKNOWN HUMAN command to FAILED on a definitive provider receipt", async () => {
    const test = harness("SENT", null, "UNKNOWN");
    const failedEvent = {
      ...baseEvent,
      schemaVersion: 3 as const,
      status: "FAILED" as const,
      failure: { providerCode: "131026" },
    };

    await expect(test.service.process(failedEvent)).resolves.toBe("applied");

    expect(test.linkedCommand).toMatchObject({
      id: "command-1",
      state: "FAILED",
      failureCode: "131026",
    });
  });

  it("notifies only after accepted compensation and reachability, including on replay", async () => {
    const test = harness("SENT", "NO_RESPONSE");
    const event = {
      ...baseEvent,
      schemaVersion: 3 as const,
      status: "FAILED" as const,
      failure: { providerCode: "131026" },
    };
    test.compensation.reconcile.mockResolvedValue("released");
    test.failureReachability.afterCorrection.mockImplementation(async () => {
      expect(test.compensation.reconcile).toHaveBeenCalled();
      return "suppressed";
    });
    test.notification.notify.mockImplementation(async () => {
      expect(test.failureReachability.afterCorrection).toHaveBeenCalled();
      return "created";
    });
    await test.service.process(event);
    await test.service.process(event);
    expect(test.notification.notify).toHaveBeenCalledTimes(2);
    expect(test.notification.notify).toHaveBeenCalledWith(
      { providerMessageId: "wamid-1" },
      "released",
      "suppressed",
    );
  });

  it("retries a notification failure without undoing durable provider status/correction", async () => {
    const test = harness("SENT", "NO_RESPONSE");
    const event = {
      ...baseEvent,
      schemaVersion: 3 as const,
      status: "FAILED" as const,
      failure: { providerCode: "131026" },
    };
    test.compensation.reconcile.mockResolvedValue("restored-spendable");
    test.failureReachability.afterCorrection.mockResolvedValue("unchanged");
    test.notification.notify.mockRejectedValueOnce(
      new Error("support offline"),
    );
    await expect(test.service.process(event)).rejects.toThrow(
      "support offline",
    );
    expect(test.message.status).toBe("FAILED");
    await expect(test.service.process(event)).resolves.toBe("ignored");
    expect(test.compensation.reconcile).toHaveBeenCalledTimes(2);
    expect(test.notification.notify).toHaveBeenCalledTimes(2);
  });

  it("orders failure reachability strictly after successful compensation, even on replay", async () => {
    const test = harness("SENT", "NO_RESPONSE");
    const event = {
      ...baseEvent,
      schemaVersion: 3 as const,
      status: "FAILED" as const,
      failure: { providerCode: "131026" },
    };
    test.compensation.reconcile.mockImplementation(async () => {
      expect(test.failureReachability.afterCorrection).toHaveBeenCalledTimes(
        test.compensation.reconcile.mock.calls.length - 1,
      );
      return "released";
    });
    await test.service.process(event);
    await test.service.process(event);
    expect(test.failureReachability.afterCorrection).toHaveBeenCalledTimes(2);
    expect(test.failureReachability.afterCorrection).toHaveBeenCalledWith(
      { providerMessageId: "wamid-1" },
      "released",
    );
  });

  it("never reaches the suppression writer when compensation throws", async () => {
    const test = harness();
    test.compensation.reconcile.mockRejectedValue(
      new Error("correction did not commit"),
    );
    await expect(
      test.service.process({
        ...baseEvent,
        schemaVersion: 3 as const,
        status: "FAILED",
        failure: { providerCode: "131026" },
      }),
    ).rejects.toThrow("correction did not commit");
    expect(test.failureReachability.afterCorrection).not.toHaveBeenCalled();
  });

  it("clears positive evidence without invoking compensation", async () => {
    const test = harness("FAILED", "FAILED");
    test.message.providerFailureCode = "131026";
    await test.service.process({ ...baseEvent, status: "READ" });
    expect(test.positiveReachability.fromProviderDelivery).toHaveBeenCalledWith(
      "wamid-1",
    );
    expect(test.compensation.reconcile).not.toHaveBeenCalled();
  });
});

function lifecycleDataFor(status: "DELIVERED"): Record<string, unknown> {
  return {
    status,
    deliveredAt: new Date(baseEvent.occurredAt),
  };
}

describe.each(["providerAccountId", "providerPhoneNumberId"] as const)(
  "ARCH076 immutable dispatch %s ownership",
  (field) => {
    it.each(["FAILED", "DELIVERED", "READ"] as const)(
      "foreign %s status has no lifecycle, billing or contact effects",
      async (status) => {
        const test = harness();
        Object.assign(test.message, {
          dispatchProviderAccountId: "account-1",
          dispatchProviderPhoneNumberId: "phone-1",
        });
        expect(
          await test.service.process({
            ...baseEvent,
            status,
            [field]: "foreign-identity",
          }),
        ).toBe("ignored");
        expect(
          test.transaction.conversationMessage.updateMany,
        ).not.toHaveBeenCalled();
        expect(test.compensation.reconcile).not.toHaveBeenCalled();
        expect(test.failureReachability.afterCorrection).not.toHaveBeenCalled();
        expect(
          test.positiveReachability.fromProviderDelivery,
        ).not.toHaveBeenCalled();
        expect(test.notification.notify).not.toHaveBeenCalled();
      },
    );
  },
);

describe("ARCH076 neutral router prompt receipts", () => {
  function routerHarness(state = "PROMPT_ADMITTED") {
    const test = harness();
    test.transaction.conversationMessage.findUnique.mockResolvedValue(null);
    const prompt = {
      inboundProviderMessageId: "original-1",
      promptProviderMessageId: "wamid-1",
      state,
      inputJson: {
        content: { type: "text", text: "private pending question" },
      },
      candidatesJson: [{ conversationId: "candidate-1" }],
      moderationJson: { allowed: true },
      promptText: "Which basket?",
      workToken: "lease",
      workLeaseUntil: new Date(),
      nextRepairAt: new Date(),
      thread: {
        providerPhoneNumberId: "phone-1",
        sender: { providerAccountId: "account-1" },
      },
    };
    test.transaction.recoveryBasketRoutingTurn.findUnique.mockResolvedValue(
      prompt,
    );
    return { ...test, prompt };
  }
  function noMerchantEffects(test: ReturnType<typeof routerHarness>) {
    expect(
      test.transaction.conversationMessage.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      test.transaction.recoveryOutreachAttempt.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      test.transaction.merchantConversationSendCommand.updateMany,
    ).not.toHaveBeenCalled();
    expect(test.transaction.usageEvent.upsert).not.toHaveBeenCalled();
    expect(test.compensation.reconcile).not.toHaveBeenCalled();
    expect(test.failureReachability.afterCorrection).not.toHaveBeenCalled();
    expect(
      test.positiveReachability.fromProviderDelivery,
    ).not.toHaveBeenCalled();
    expect(test.notification.notify).not.toHaveBeenCalled();
  }
  it.each(["SENT", "DELIVERED", "READ"] as const)(
    "accepts exact %s prompt receipt without merchant accounting",
    async (status) => {
      const test = routerHarness();
      expect(await test.service.process({ ...baseEvent, status })).toBe(
        "applied",
      );
      expect(
        test.transaction.recoveryBasketRoutingTurn.findUnique,
      ).toHaveBeenCalledWith({
        where: { promptProviderMessageId: "wamid-1" },
        include: { thread: { include: { sender: true } } },
      });
      expect(
        test.transaction.recoveryBasketRoutingTurn.update,
      ).not.toHaveBeenCalled();
      noMerchantEffects(test);
    },
  );
  it.each(["providerAccountId", "providerPhoneNumberId"] as const)(
    "ignores foreign %s on a known prompt",
    async (field) => {
      const test = routerHarness();
      expect(
        await test.service.process({
          ...baseEvent,
          schemaVersion: 3,
          status: "FAILED",
          failure: { providerCode: "131049" },
          [field]: "foreign",
        }),
      ).toBe("ignored");
      expect(
        test.transaction.recoveryBasketRoutingTurn.update,
      ).not.toHaveBeenCalled();
      noMerchantEffects(test);
    },
  );
  it.each(["RECEIVED", "PROMPT_ADMITTED", "PROMPT_UNKNOWN"])(
    "expires and destructively scrubs a failed %s prompt",
    async (state) => {
      const test = routerHarness(state);
      expect(
        await test.service.process({
          ...baseEvent,
          schemaVersion: 3,
          status: "FAILED",
          failure: { providerCode: "131049" },
        }),
      ).toBe("applied");
      expect(
        test.transaction.recoveryBasketRoutingTurn.update,
      ).toHaveBeenCalledWith({
        where: { inboundProviderMessageId: "original-1" },
        data: {
          state: "EXPIRED",
          inputJson: null,
          candidatesJson: null,
          moderationJson: null,
          promptText: null,
          workToken: null,
          workLeaseUntil: null,
          nextRepairAt: null,
        },
      });
      noMerchantEffects(test);
    },
  );
  it.each(["RESOLVED", "EXPIRED", "IGNORED"])(
    "does not resurrect or rewrite terminal %s prompt history",
    async (state) => {
      const test = routerHarness(state);
      expect(
        await test.service.process({
          ...baseEvent,
          schemaVersion: 3,
          status: "FAILED",
          failure: { providerCode: "131049" },
        }),
      ).toBe("applied");
      expect(
        test.transaction.recoveryBasketRoutingTurn.update,
      ).not.toHaveBeenCalled();
      noMerchantEffects(test);
    },
  );
});
