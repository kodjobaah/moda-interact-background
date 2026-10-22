import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/db.js", () => ({ default: {} }));
vi.mock("../../../src/services/recovery-delivery-compensation/reconcile.service.js", () => ({
  recoveryDeliveryCompensationService: { reconcile: vi.fn() },
}));
vi.mock("@prisma/client", () => ({
  MessageStatus: {
    PENDING: "PENDING",
    FAILED: "FAILED",
    SENT: "SENT",
    DELIVERED: "DELIVERED",
    READ: "READ",
  },
  Prisma: {
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
  const linkedAttempt = attemptStatus === null
    ? null
    : { id: "attempt-1", status: attemptStatus };
  const linkedCommand = commandState === null
    ? null
    : { id: "command-1", state: commandState };
  const message = {
    id: "message-1",
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
    conversationMessage: {
      findUnique: vi.fn().mockResolvedValue(message),
      updateMany: vi
        .fn()
        .mockImplementation(
          async ({ where, data }: {
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
    recoveryOutreachAttempt: {
      updateMany: vi.fn().mockImplementation(async ({ where, data }: {
        where: { id: string; status: string };
        data: Record<string, unknown>;
      }) => {
        if (
          !linkedAttempt ||
          where.id !== linkedAttempt.id ||
          where.status !== linkedAttempt.status
        ) return { count: 0 };
        Object.assign(linkedAttempt, data);
        return { count: 1 };
      }),
    },
    merchantConversationSendCommand: {
      updateMany: vi.fn().mockImplementation(async ({ where, data }: {
        where: { id: string; state: { in: string[] } };
        data: Record<string, unknown>;
      }) => {
        if (
          !linkedCommand ||
          where.id !== linkedCommand.id ||
          !where.state.in.includes(linkedCommand.state)
        ) return { count: 0 };
        Object.assign(linkedCommand, data);
        return { count: 1 };
      }),
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
      findUnique: vi.fn().mockRejectedValue(
        new Error("provider status must not resolve Shop execution eligibility"),
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
  const failureReachability = { afterCorrection: vi.fn().mockResolvedValue("not-applicable") };
  const positiveReachability = { fromProviderDelivery: vi.fn().mockResolvedValue("unchanged") };
  const notification = { notify: vi.fn().mockResolvedValue("skipped") };
  const serviceLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };

  return {
    message,
    linkedAttempt,
    linkedCommand,
    usageEvents,
    transaction,
    database,
    serviceLogger,
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

describe("WhatsAppProviderStatusService", () => {
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

    await test.service.process(baseEvent);
    expect(test.message.status).toBe("DELIVERED");
    expect(test.linkedAttempt?.status).toBe("FAILED");
    expect(test.usageEvents).toHaveLength(1);
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

    await expect(test.service.process({
      ...baseEvent,
      schemaVersion: 3 as const,
      status: "FAILED" as const,
      failure: { providerCode: "131026" },
    })).resolves.toBe("applied");

    expect(test.message.status).toBe("FAILED");
    expect(test.message.providerFailureCode).toBe("131026");
    expect(test.linkedAttempt).toMatchObject({ id: "attempt-1", status: "FAILED" });
    expect(test.transaction.recoveryOutreachAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: "attempt-1", status: "WAITING_FOR_RESPONSE" },
      data: {
        status: "FAILED",
        failureCode: "WHATSAPP_RECIPIENT_UNDELIVERABLE",
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
  ])("preserves an already-converged %s attempt for late 131026 evidence", async (attemptStatus) => {
    const test = harness("SENT", attemptStatus);

    await test.service.process({
      ...baseEvent,
      schemaVersion: 3 as const,
      status: "FAILED" as const,
      failure: { providerCode: "131026" },
    });

    expect(test.linkedAttempt?.status).toBe(attemptStatus);
    expect(test.transaction.recoveryOutreachAttempt.updateMany).not.toHaveBeenCalled();
    expect(test.message.providerFailureCode).toBe("131026");
  });

  it("does not converge a waiting attempt for other provider failure codes", async () => {
    const test = harness();

    await test.service.process({
      ...baseEvent,
      schemaVersion: 3 as const,
      status: "FAILED" as const,
      failure: { providerCode: "131047" },
    });

    expect(test.linkedAttempt?.status).toBe("WAITING_FOR_RESPONSE");
    expect(test.transaction.recoveryOutreachAttempt.updateMany).not.toHaveBeenCalled();
  });

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
      expect(test.transaction.recoveryOutreachAttempt.updateMany).not.toHaveBeenCalled();
    },
  );

  it("reinvokes compensation outside the status transaction on a failed replay", async () => {
    const test = harness("SENT", "NO_RESPONSE");
    const failure = { ...baseEvent, schemaVersion: 3 as const,
      status: "FAILED" as const, failure: { providerCode: "131026" } };
    test.compensation.reconcile.mockImplementation(async () => {
      expect(test.database.$transaction).toHaveBeenCalledTimes(test.compensation.reconcile.mock.calls.length);
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
    const failure = { ...baseEvent, schemaVersion: 3 as const,
      status: "FAILED" as const, failure: { providerCode: "131026" } };
    test.compensation.reconcile.mockRejectedValueOnce(new Error("ledger not available"));
    await expect(test.service.process(failure)).rejects.toThrow("ledger not available");
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
    expect(test.transaction.recoveryOutreachAttempt.updateMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["DELIVERED", "SENT"],
    ["READ", "SENT"],
    ["DELIVERED", "FAILED"],
    ["READ", "FAILED"],
  ] as const)("ignores late %s -> %s evidence", async (currentStatus, eventStatus) => {
    const test = harness(currentStatus);

    await expect(
      test.service.process({ ...baseEvent, status: eventStatus }),
    ).resolves.toBe("ignored");

    expect(test.message.status).toBe(currentStatus);
    expect(test.transaction.conversationMessage.updateMany).not.toHaveBeenCalled();
  });

  it("bounds unknown and invalid events without touching durable state", async () => {
    const test = harness();

    await expect(
      test.service.process({ ...baseEvent, providerMessageId: "" }),
    ).resolves.toBe("invalid");
    test.transaction.conversationMessage.findUnique.mockResolvedValueOnce(null);
    await expect(test.service.process(baseEvent)).resolves.toBe(
      "unknown-message",
    );

    expect(test.transaction.conversationMessage.updateMany).not.toHaveBeenCalled();
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
    expect(test.transaction.conversationMessage.updateMany).not.toHaveBeenCalled();
  });

  it("derives accounting from the durable message shop, not provider identities", async () => {
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

    expect(test.usageEvents[0]).toMatchObject({ shopId: "durable-shop" });
  });

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
    test.transaction.conversationMessage.updateMany = vi.fn().mockImplementation(
      async (args) => {
        updateAttempts += 1;
        if (updateAttempts === 1) {
          Object.assign(test.message, lifecycleDataFor("DELIVERED"));
          test.usageEvents.push({ idempotencyKey: "whatsapp-delivered:message-1" });
        }
        return originalUpdateMany(args);
      },
    );

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
    test.transaction.conversationMessage.updateMany = vi.fn().mockImplementation(
      async (args) => {
        updateAttempts += 1;
        if (updateAttempts === 1) {
          Object.assign(test.message, lifecycleDataFor("DELIVERED"));
          test.usageEvents.push({ idempotencyKey: "whatsapp-delivered:message-1" });
        }
        return originalUpdateMany(args);
      },
    );

    await Promise.all([
      test.service.process(baseEvent),
      test.service.process({ ...baseEvent, status: "FAILED" }),
    ]);

    expect(test.message.status).toBe("DELIVERED");
    expect(test.usageEvents).toHaveLength(1);
  });

  it("converges a HUMAN command from DISPATCH_ADMITTED when SENT receipt arrives", async () => {
    const test = harness("SENT", null, "DISPATCH_ADMITTED");

    await expect(test.service.process({ ...baseEvent, status: "SENT" })).resolves.toBe("applied");

    expect(test.linkedCommand).toMatchObject({ id: "command-1", state: "SENT" });
    expect(test.transaction.merchantConversationSendCommand.updateMany).toHaveBeenCalledWith({
      where: { id: "command-1", state: { in: ["DISPATCH_ADMITTED", "UNKNOWN"] } },
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

    expect(test.linkedCommand).toMatchObject({ id: "command-1", state: "FAILED", failureCode: "131026" });
  });

  it("notifies only after accepted compensation and reachability, including on replay", async () => {
    const test = harness("SENT", "NO_RESPONSE");
    const event = { ...baseEvent, schemaVersion: 3 as const,
      status: "FAILED" as const, failure: { providerCode: "131026" } };
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
      { providerMessageId: "wamid-1" }, "released", "suppressed",
    );
  });

  it("retries a notification failure without undoing durable provider status/correction", async () => {
    const test = harness("SENT", "NO_RESPONSE");
    const event = { ...baseEvent, schemaVersion: 3 as const,
      status: "FAILED" as const, failure: { providerCode: "131026" } };
    test.compensation.reconcile.mockResolvedValue("restored-spendable");
    test.failureReachability.afterCorrection.mockResolvedValue("unchanged");
    test.notification.notify.mockRejectedValueOnce(new Error("support offline"));
    await expect(test.service.process(event)).rejects.toThrow("support offline");
    expect(test.message.status).toBe("FAILED");
    await expect(test.service.process(event)).resolves.toBe("ignored");
    expect(test.compensation.reconcile).toHaveBeenCalledTimes(2);
    expect(test.notification.notify).toHaveBeenCalledTimes(2);
  });

  it("orders failure reachability strictly after successful compensation, even on replay", async () => {
    const test = harness("SENT", "NO_RESPONSE");
    const event = { ...baseEvent, schemaVersion: 3 as const,
      status: "FAILED" as const, failure: { providerCode: "131026" } };
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
      { providerMessageId: "wamid-1" }, "released",
    );
  });

  it("never reaches the suppression writer when compensation throws", async () => {
    const test = harness();
    test.compensation.reconcile.mockRejectedValue(new Error("correction did not commit"));
    await expect(test.service.process({ ...baseEvent, schemaVersion: 3 as const,
      status: "FAILED", failure: { providerCode: "131026" } })).rejects.toThrow(
      "correction did not commit",
    );
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
