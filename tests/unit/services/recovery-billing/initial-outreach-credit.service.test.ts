import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { freeRecoveryReservationService } from "../../../../src/services/free-recovery-reservation.service.js";
vi.mock("../../../../src/services/free-recovery-reservation.service.js", () => ({
  freeRecoveryReservationService: { commitInExistingTransaction: vi.fn() },
}));
import { InitialOutreachCreditService } from "../../../../src/services/recovery-billing/initial-outreach-credit.service.js";
import {
  attemptEvidence,
  captureLogger,
  databaseFor,
  input,
  transactionForAttempt,
} from "./initial-outreach-credit.test-support.js";
import type { LogRecord } from "@modainteract/moda-interact-shared/logging";

describe("InitialOutreachCreditService", () => {
  it("commits the exact free source only after durable positive message evidence", async () => {
    const records: LogRecord[] = [];
    const sourceKey = createRecoveryIdempotencyKey(input.shopId, `recovery-outreach:${input.outreachAttemptId}`);
    const usageId = "usage-credit-1";
    let reservation = {
      id: "reservation-1",
      shopId: input.shopId,
      sourceKey,
      counterId: "counter-1",
      purchasedCreditPurchaseId: null,
      billingPeriodEntitlementCounterId: null,
      promotionalCreditGrantId: null,
      quantity: 1,
      status: "RESERVED",
      committedUsageEventId: null as string | null,
      compensationUsageEventId: null,
      compensationReason: null,
      compensationDisposition: null,
      compensatedAt: null,
      expiresAt: null,
    };
    const usage = {
      id: usageId,
      shopId: input.shopId,
      metric: "RECOVERY_CONVERSATION",
      sourceType: "FREE_RECOVERY_RESERVATION",
      sourceId: reservation.id,
      idempotencyKey: createRecoveryIdempotencyKey(input.shopId, sourceKey),
      quantity: new Prisma.Decimal(1),
      provider: "SHOPIFY",
      billingPeriodId: null,
      correctionOfUsageEventId: null,
    };
    const attempt = { ...attemptEvidence(), outboundMessageId: "message-1" };
    const message = {
      id: "message-1",
      providerMessageId: "provider-1",
      conversationId: "conversation-1",
      direction: "OUTBOUND",
      senderType: "AUTOMATION",
      status: "SENT",
      providerDispatchKey: null,
      providerDispatchAdmittedAt: null,
      providerDispatchControlRevision: null,
      sentAt: new Date("2026-09-08T15:00:00.000Z"),
      deliveredAt: null,
      readAt: null,
      providerFailureCode: null,
      failedAt: null,
      recoveryOutreachAttempt: { id: input.outreachAttemptId },
      merchantSendCommand: null,
      conversation: {
        id: "conversation-1",
        shopId: input.shopId,
        checkoutRecovery: { id: input.recoveryId, shopId: input.shopId },
      },
    };
    const tx = {
      $queryRaw: async () => [{ id: input.shopId, platform: "SHOPIFY" }],
      recoveryOutreachAttempt: { findUnique: async () => attempt },
      conversationMessage: {
        findUnique: async () => message,
        findFirst: async () => null,
      },
      merchantConversationSendCommand: { findFirst: async () => null },
      usageReservation: { findMany: async () => [reservation] },
      shopEntitlementCounter: { findUnique: async () => ({ shopId: input.shopId, counter: "LIFETIME_FREE_RECOVERY_CREDITS" }) },
      usageEvent: {
        findMany: async () => [],
        findUnique: async ({ where }: { where: { id?: string } }) => where.id === usageId ? usage : null,
        count: async () => 0,
      },
    };
    vi.mocked(freeRecoveryReservationService.commitInExistingTransaction).mockImplementationOnce(async () => {
      reservation = { ...reservation, status: "COMMITTED", committedUsageEventId: usageId };
      return { kind: "committed", reservation } as never;
    });
    const service = new InitialOutreachCreditService(databaseFor(tx) as never, captureLogger(records));

    await expect(service.settleConfirmedInitialOutreach({
      ...input,
      outboundMessageId: message.id,
    })).resolves.toEqual({
      kind: "settled",
      disposition: "committed",
      sourceKind: "free",
      sourceKey,
      reservationId: "reservation-1",
      committedUsageEventId: usageId,
      outboundMessageId: message.id,
      sentAt: message.sentAt,
    });
    expect(freeRecoveryReservationService.commitInExistingTransaction).toHaveBeenCalledWith(tx, {
      shopId: input.shopId,
      sourceKey,
    });
    expect(records).toHaveLength(0);
  });

  it("returns and emits a pure message-not-confirmed hold without invented error data", async () => {
    const records: LogRecord[] = [];
    const tx = transactionForAttempt();
    const service = new InitialOutreachCreditService(databaseFor(tx) as never, captureLogger(records));

    const result = await service.settleConfirmedInitialOutreach({
      ...input,
      outboundMessageId: "message-1",
    });

    expect(result).toEqual({ kind: "held", reason: "message-not-confirmed" });
    const record = JSON.parse(JSON.stringify(records[0])) as Record<string, unknown>;
    expect(record).toMatchObject({ level: "warn", event: "recovery.initial_outreach_credit.held" });
    expect(JSON.stringify(record)).toContain('"reason":"message-not-confirmed"');
    expect(JSON.stringify(record)).not.toContain('"error"');
    expect(JSON.stringify(record)).not.toContain('"providerCode"');
  });

  it("returns absent only for a null-message attempt with no discoverable evidence or source", async () => {
    const records: LogRecord[] = [];
    const tx = transactionForAttempt({
      usageReservation: { findMany: async () => [] },
    });
    const service = new InitialOutreachCreditService(databaseFor(tx) as never, captureLogger(records));

    await expect(service.revalidateExistingInitialOutreach({
      ...input,
      outboundMessageId: null,
    })).resolves.toEqual({ kind: "absent" });
    expect(records).toHaveLength(0);
  });

  it("logs the original failure through Shared and rethrows the same object", async () => {
    const records: LogRecord[] = [];
    const original = new Error("credit identity read failed");
    const tx = transactionForAttempt({
      recoveryOutreachAttempt: { findUnique: async () => { throw original; } },
    });
    const service = new InitialOutreachCreditService(databaseFor(tx) as never, captureLogger(records));

    await expect(service.settleConfirmedInitialOutreach({
      ...input,
      outboundMessageId: "message-1",
    })).rejects.toBe(original);
    expect(records).toHaveLength(1);
    const emitted = JSON.stringify(records[0]);
    expect(emitted).toContain("recovery.initial_outreach_credit.failed");
    expect(emitted).toContain("credit identity read failed");
    expect(emitted).toContain('"stage":"identity"');
  });

  it("emits bounded Prisma metadata while excluding arbitrary metadata", async () => {
    const records: LogRecord[] = [];
    const original = new Prisma.PrismaClientKnownRequestError("unique conflict sentinel", {
      code: "P2002",
      clientVersion: Prisma.prismaVersion.client,
      meta: { modelName: "UsageReservation", target: ["sourceKey"], unsafe: "do-not-log" },
    });
    const tx = transactionForAttempt({
      recoveryOutreachAttempt: { findUnique: async () => { throw original; } },
    });
    const service = new InitialOutreachCreditService(databaseFor(tx) as never, captureLogger(records));

    await expect(service.settleConfirmedInitialOutreach({
      ...input,
      outboundMessageId: "message-1",
    })).rejects.toBe(original);
    const emitted = JSON.stringify(records);
    expect(emitted).toContain("unique conflict sentinel");
    expect(emitted).toContain('"code":"P2002"');
    expect(emitted).toContain('"modelName":"UsageReservation"');
    expect(emitted).toContain('"target":["sourceKey"]');
    expect(emitted).not.toContain("do-not-log");
  });

  it("logs each actual retry and the exhausted failure without replacing the original error", async () => {
    const records: LogRecord[] = [];
    const original = new Prisma.PrismaClientKnownRequestError("", {
      code: "P2034",
      clientVersion: Prisma.prismaVersion.client,
    });
    const database = {
      $transaction: async () => { throw original; },
    };
    const service = new InitialOutreachCreditService(database as never, captureLogger(records), 3);

    await expect(service.settleConfirmedInitialOutreach({
      ...input,
      outboundMessageId: "message-1",
    })).rejects.toBe(original);

    const emitted = records.map((record) => JSON.parse(JSON.stringify(record)) as Record<string, unknown>);
    const serialized = JSON.stringify(emitted);
    expect(emitted.filter((record) => record.event === "recovery.initial_outreach_credit.retry")).toHaveLength(2);
    expect(emitted.filter((record) => record.event === "recovery.initial_outreach_credit.failed")).toHaveLength(1);
    expect(serialized).toContain('"attempt":1');
    expect(serialized).toContain('"attempt":2');
    expect(serialized).toContain('"attempt":3');
    expect(serialized).toContain('"maxAttempts":3');
    expect(serialized).toContain('"retryExhausted":true');
    expect(serialized).toContain('"reasonCode":"P2034"');
    expect(serialized).not.toContain("providerCode");
  });

  it("preserves the original failure when the actual Shared sink throws", async () => {
    const original = new Error("source lookup failed");
    const logger = createLogger({
      serviceName: "initial-outreach-credit-test",
      environment: "test",
      sink: () => { throw new Error("sink unavailable"); },
    });
    const tx = transactionForAttempt({
      recoveryOutreachAttempt: { findUnique: async () => { throw original; } },
    });
    const service = new InitialOutreachCreditService(databaseFor(tx) as never, logger);

    await expect(service.settleConfirmedInitialOutreach({
      ...input,
      outboundMessageId: "message-1",
    })).rejects.toBe(original);
  });

  it("rejects null-message absence when attempt evidence is already linked", async () => {
    const records: LogRecord[] = [];
    const attempt = { ...attemptEvidence(), outboundMessageId: "message-existing" };
    const tx = transactionForAttempt({
      recoveryOutreachAttempt: { findUnique: async () => attempt },
      usageReservation: { findMany: async () => [] },
    });
    const service = new InitialOutreachCreditService(databaseFor(tx) as never, captureLogger(records));

    await expect(service.revalidateExistingInitialOutreach({
      ...input,
      outboundMessageId: null,
    })).resolves.toMatchObject({ kind: "held", reason: "lineage-conflict" });
    const record = JSON.parse(JSON.stringify(records[0])) as {
      level: string;
      event: string;
      data: { reason: string; stage: string; error: { name: string; message: string } };
    };
    expect(record).toMatchObject({
      level: "warn",
      event: "recovery.initial_outreach_credit.held",
      data: {
        reason: "lineage-conflict",
        stage: "identity",
        error: {
          name: "RecoveryCompensationLineageError",
          message: expect.stringContaining("initial attempt has existing message or send evidence"),
        },
      },
    });
  });
});
