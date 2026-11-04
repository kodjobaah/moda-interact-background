import { describe, expect, it, vi } from "vitest";
import { OutboundAdmissionReservationService } from "../../../../src/services/outbound-whatsapp-admission/outbound-admission-reservation.service.js";

const scope = { shopId: "shop-1", recoveryId: "recovery-1", outreachAttemptId: "attempt-1" };

function harness() {
  const attempt = {
    id: scope.outreachAttemptId, checkoutRecoveryId: scope.recoveryId,
    checkoutRecovery: { shopId: scope.shopId, status: "DETECTED" },
    recipient: "+447400123456", sequence: 1, trigger: "INITIAL", status: "PENDING",
    outboundMessageId: null, sentAt: null, followUpDueAt: null, closedAt: null,
  };
  const message = {
    id: "message-1", conversationId: "conversation-1",
    direction: "OUTBOUND", senderType: "AUTOMATION", status: "PENDING",
    sentAt: null, deliveredAt: null, readAt: null, failedAt: null,
    providerMessageId: null, providerDispatchKey: null, providerDispatchAdmittedAt: null,
    providerDispatchControlRevision: null, providerFailureCode: null,
    merchantSendCommand: null, recoveryOutreachAttempt: null,
  };
  const usage = {
    sourceId: message.id, shopId: scope.shopId, metric: "OUTBOUND_AUTOMATED_MESSAGE",
    sourceType: "OUTBOUND_AUTOMATED_MESSAGE", quantity: 1,
  };
  const tx = {
    recoveryOutreachAttempt: { findUnique: vi.fn().mockResolvedValue(attempt) },
    usageEvent: { findUnique: vi.fn().mockResolvedValue(usage) },
    conversation: { findUnique: vi.fn().mockResolvedValue({
      id: message.conversationId, shopId: scope.shopId, type: "RECOVERY",
    }) },
    conversationMessage: { findUnique: vi.fn().mockResolvedValue(message) },
  };
  const service = new OutboundAdmissionReservationService({
    $transaction: async (read: (client: typeof tx) => Promise<unknown>) => read(tx),
  } as never);
  return { attempt, message, usage, tx, service };
}

describe("initial outreach admission evidence", () => {
  it("finds only the original prepared message and canonical usage identity", async () => {
    const { service, tx } = harness();
    await expect(service.inspectInitialOutreachAdmission(scope)).resolves.toMatchObject({
      kind: "prepared", message: { id: "message-1" },
    });
    expect(tx.usageEvent.findUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: "recovery-outreach:attempt-1" },
    });
  });

  it.each([
    ["providerDispatchControlRevision", 0],
    ["providerDispatchKey", "permit"],
    ["providerDispatchAdmittedAt", new Date()],
    ["providerMessageId", "wamid"],
    ["deliveredAt", new Date()],
    ["readAt", new Date()],
    ["failedAt", new Date()],
  ])("holds PENDING evidence with %s", async (field, value) => {
    const { service, message, tx } = harness();
    tx.conversationMessage.findUnique.mockResolvedValue({ ...message, [field]: value });
    await expect(service.inspectInitialOutreachAdmission(scope)).resolves.toEqual({
      kind: "held", reason: "provider-outcome-unknown",
    });
  });

  it("holds a foreign usage event or a merchant-command association", async () => {
    const { service, message, usage, tx } = harness();
    tx.usageEvent.findUnique.mockResolvedValueOnce({ ...usage, shopId: "foreign" });
    tx.conversationMessage.findUnique.mockResolvedValue({
      ...message, merchantSendCommand: { id: "command" },
    });
    for (let i = 0; i < 2; i++) {
      await expect(service.inspectInitialOutreachAdmission(scope)).resolves.toEqual({
        kind: "held", reason: "lineage-conflict",
      });
    }
  });
});
