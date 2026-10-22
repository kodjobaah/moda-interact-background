import { describe, expect, it, vi } from "vitest";
import { SynchronousRecipientFailureEvidenceService } from "../../../src/services/synchronous-recipient-failure-evidence.service.js";

function fixture({ usageKey = "recovery-outreach:attempt-1", shopId = "shop-1",
  attemptShop = "shop-1", recipient = "447700900001", linkedMessageId = null as string | null } = {}) {
  const message = {
    direction: "OUTBOUND", status: "PENDING", senderType: "AUTOMATION",
    providerMessageId: null, providerFailureCode: null,
    conversation: { shopId,
      checkoutRecovery: { id: "recovery-1", shopId } },
  };
  const attempt = { checkoutRecoveryId: "recovery-1", recipient,
    outboundMessageId: linkedMessageId, shopId: attemptShop };
  const usage = { shopId, idempotencyKey: usageKey };
  const tx = {
    conversationMessage: {
      findUnique: vi.fn(async () => message),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(message, data); return { count: 1 };
      }),
    },
    usageEvent: { findMany: vi.fn(async () => [usage]) },
    recoveryOutreachAttempt: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        "id" in where ? attempt : null),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(attempt, data); return { count: 1 };
      }),
    },
  };
  const database = { $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)) };
  const subject = new SynchronousRecipientFailureEvidenceService(database as never);
  return { subject, tx, attempt, message };
}

describe("ARCH-028-BACKGROUND-006 durable synchronous 131026 evidence", () => {
  it("links exact attempt and records FAILED in one transaction before compensation", async () => {
    const x = fixture();
    const at = new Date("2026-10-22T15:00:00.000Z");
    await x.subject.record("message-1", "447700900001", at);
    expect(x.attempt.outboundMessageId).toBe("message-1");
    expect(x.attempt).toMatchObject({ status: "FAILED", failureCode: "WHATSAPP_RECIPIENT_UNDELIVERABLE" });
    expect(x.message).toMatchObject({ status: "FAILED", providerFailureCode: "131026", failedAt: at });
    expect(x.tx.usageEvent.findMany).toHaveBeenCalledOnce();
  });

  it("rejects recipient mismatch and never records a false failed recipient", async () => {
    const x = fixture({ recipient: "447700900002" });
    await expect(x.subject.record("message-1", "447700900001")).rejects.toThrow("mismatch");
    expect(x.tx.conversationMessage.updateMany).not.toHaveBeenCalled();
  });

  it("replays an already-linked message without linking another attempt", async () => {
    const x = fixture({ linkedMessageId: "message-1" });
    await x.subject.record("message-1", "447700900001");
    expect(x.tx.recoveryOutreachAttempt.updateMany).not.toHaveBeenCalled();
    expect(x.message.status).toBe("FAILED");
  });
});
