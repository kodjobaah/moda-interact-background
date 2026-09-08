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
      update: vi
        .fn()
        .mockImplementation(
          async ({ data }: { data: Record<string, unknown> }) => {
            Object.assign(message, data);
            return message;
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

    expect(test.transaction.conversationMessage.update).not.toHaveBeenCalled();
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
});
