import { describe, expect, it, vi } from "vitest";

import { WhatsAppProviderStatusService } from "../../../src/services/whatsapp-provider-status.service.js";

const baseEvent = {
  schemaVersion: 2 as const,
  providerAccountId: "account-1",
  providerPhoneNumberId: "phone-1",
  providerMessageId: "wamid-1",
  status: "DELIVERED" as const,
  occurredAt: "2026-09-08T15:00:00.000Z",
};

function harness(status = "SENT") {
  const message = {
    id: "message-1",
    direction: "OUTBOUND",
    status,
    sentAt: new Date("2026-09-08T14:59:00.000Z"),
    deliveredAt: null as Date | null,
    readAt: null as Date | null,
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
    $transaction: vi
      .fn()
      .mockImplementation(
        async (operation: (client: typeof transaction) => unknown) =>
          operation(transaction),
      ),
  };
  const serviceLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };

  return {
    message,
    usageEvents,
    transaction,
    database,
    serviceLogger,
    service: new WhatsAppProviderStatusService(
      database as never,
      serviceLogger as never,
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

    await test.service.process({ ...baseEvent, status: "FAILED" });
    expect(test.message.status).toBe("FAILED");

    await test.service.process(baseEvent);
    expect(test.message.status).toBe("DELIVERED");
    expect(test.usageEvents).toHaveLength(1);
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
});

function lifecycleDataFor(status: "DELIVERED"): Record<string, unknown> {
  return {
    status,
    deliveredAt: new Date(baseEvent.occurredAt),
  };
}
