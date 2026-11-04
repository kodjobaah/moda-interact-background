import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@modainteract/moda-interact-shared/logging";

const deps = vi.hoisted(() => ({
  settle: vi.fn(),
  support: vi.fn(),
  recoveryUpdate: vi.fn(),
  recoveryRead: vi.fn(),
  attemptRead: vi.fn(),
}));

vi.mock("../../../../src/services/recovery-billing.service.js", () => ({
  recoveryBillingService: { settleConfirmedInitialOutreach: deps.settle },
}));
vi.mock("../../../../src/services/checkout-recovery/recovery-initial-outreach-support-notice.service.js", () => ({
  recoveryInitialOutreachSupportNoticeService: { finalizeConfirmedInitial: deps.support },
}));
vi.mock("../../../../src/lib/db.js", () => ({ default: {
  checkoutRecovery: { updateMany: deps.recoveryUpdate, findUnique: deps.recoveryRead },
  conversation: { findUnique: vi.fn(async () => ({ id: "conversation-1" })) },
  recoveryOutreachAttempt: { findUnique: deps.attemptRead },
} }));
vi.mock("../../../../src/services/conversation.service.js", () => ({
  conversationService: { getOrCreateRecoveryConversation: vi.fn(async () => ({ id: "conversation-1" })) },
}));

import { createWooRecoveryOutreachService } from "../../../../src/services/woocommerce-recovery/woo-recovery-outreach.adapters.js";
import type { WooOutreachDependencies } from "../../../../src/services/woocommerce-recovery/woo-recovery-outreach.service.js";

function makeAdapter(logger: WooOutreachDependencies["logger"]) {
  const recovery = {
    id: "recovery-1", shopId: "shop-1", checkoutToken: "checkout-1", customerId: "customer-1",
    status: "DETECTED" as const, completedAt: null,
    shop: { platform: "WOOCOMMERCE", status: "ACTIVE" },
  };
  const attempt = {
    id: "attempt-1", sequence: 1, recipient: "447000111222", status: "PENDING" as const,
    sentAt: null, outboundMessageId: null, followUpDueAt: null,
  };
  const confirmedMessage = {
    id: "message-1", conversationId: "conversation-1", status: "SENT" as const,
    sentAt: new Date("2026-10-27T10:00:00.000Z"),
  };
  const send = vi.fn();
  const service = createWooRecoveryOutreachService({
    coordinator: { withCheckoutLock: async (_reference: unknown, run: () => Promise<unknown>) => run() } as never,
    orders: { read: async () => ({ kind: "none-observed" as const }) },
    guardedSender: { sendInitial: send, findExistingAdmission: async () => confirmedMessage } as never,
    enqueue: { initial: vi.fn() },
    logger,
  });
  deps.recoveryRead.mockResolvedValue(recovery);
  deps.attemptRead.mockResolvedValue(attempt);
  return { service, recovery, attempt, confirmedMessage, send };
}

describe("Woo confirmed initial settlement adapter", () => {
  beforeEach(() => {
    deps.settle.mockReset();
    deps.support.mockReset();
    deps.recoveryUpdate.mockReset();
    deps.recoveryRead.mockReset();
    deps.attemptRead.mockReset();
    deps.recoveryUpdate.mockResolvedValue({ count: 1 });
    deps.support.mockResolvedValue({ outcome: "created", outreachAttemptId: "attempt-1" });
  });

  it("logs the actual finalization stage and unchanged source failure through Shared", async () => {
    const records: unknown[] = [];
    const logger = createLogger({ serviceName: "moda-recovery-worker", environment: "test",
      sink: (record) => records.push(JSON.parse(JSON.stringify(record))) });
    const f = makeAdapter(logger);
    const source = new Error("Woo exact settlement SQL failure phone +447000111222 token=private-value");
    deps.settle.mockRejectedValueOnce(source);

    await expect(f.service.processInitial("recovery-1")).rejects.toBe(source);

    const record = records.find((entry) => (entry as { event?: string }).event ===
      "recovery.initial_outreach_support_notice.woocommerce_finalization_failed") as {
        level: string; data: Record<string, unknown>;
      } | undefined;
    expect(record).toMatchObject({ level: "error", data: {
      shopId: "shop-1", checkoutRecoveryId: "recovery-1", outreachAttemptId: "attempt-1",
      outboundMessageId: "message-1", stage: "billing",
      sourceError: { name: "Error",
        message: "Woo exact settlement SQL failure phone [REDACTED_PHONE] [REDACTED_CREDENTIAL]",
        redactionApplied: true },
    } });
    expect(JSON.stringify(record)).not.toContain("+447000111222");
    expect(JSON.stringify(record)).not.toContain("private-value");
    expect(deps.support).not.toHaveBeenCalled();
    expect(deps.recoveryUpdate).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("returns exact settlement holds before Support or success status", async () => {
    const records: unknown[] = [];
    const logger = createLogger({ serviceName: "moda-recovery-worker", environment: "test",
      sink: (record) => records.push(JSON.parse(JSON.stringify(record))) });
    const f = makeAdapter(logger);
    deps.settle.mockResolvedValueOnce({ kind: "held", reason: "reservation-ambiguous" });

    await expect(f.service.processInitial("recovery-1")).resolves.toMatchObject({
      kind: "deferred", reason: "confirmed-settlement-reservation-ambiguous",
    });
    expect(deps.support).not.toHaveBeenCalled();
    expect(deps.recoveryUpdate).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(records.some((entry) => JSON.stringify(entry).includes("reservation-ambiguous"))).toBe(true);
  });
});
