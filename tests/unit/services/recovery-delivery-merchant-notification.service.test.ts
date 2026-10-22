import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/db.js", () => ({ default: {} }));

import { RecoveryDeliveryMerchantNotificationService } from
  "../../../src/services/recovery-delivery-merchant-notification.service.js";

function harness(code: string | null = "131026") {
  const message = {
    id: "message-1", direction: "OUTBOUND", status: "FAILED",
    providerFailureCode: code,
    conversation: {
      shopId: "shop-1",
      checkoutRecovery: { id: "recovery-1", shopId: "shop-1" },
    },
  };
  const database = { conversationMessage: { findUnique: vi.fn().mockResolvedValue(message) } };
  const support = { write: vi.fn().mockResolvedValue("created") };
  const service = new RecoveryDeliveryMerchantNotificationService(database as never, support);
  return { message, database, support, service };
}

const identity = { messageId: "message-1" };

describe("ARCH-028-BACKGROUND-008 post-correction notification admission", () => {
  it("writes only after successful compensation and required suppression", async () => {
    const test = harness();
    await expect(test.service.notify(identity, "released", "suppressed")).resolves.toBe("created");
    expect(test.support.write).toHaveBeenCalledWith(expect.objectContaining({
      shopId: "shop-1", recoveryId: "recovery-1", messageId: "message-1",
    }));
    expect(test.support.write.mock.calls[0]?.[0].body).toContain("temporarily paused");
  });

  it("accepts an idempotent unchanged reachability outcome without claiming new suppression", async () => {
    const test = harness();
    await test.service.notify({ providerMessageId: "wamid-1" }, "restored-spendable", "unchanged");
    expect(test.database.conversationMessage.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { providerMessageId: "wamid-1" } }),
    );
    expect(test.support.write.mock.calls[0]?.[0].body).not.toContain("temporarily paused");
  });

  it("refuses to notify for uncorrected or deferred purchased sources", async () => {
    const test = harness();
    for (const correction of ["not-terminal", "not-recovery"] as const) {
      expect(await test.service.notify(identity, correction, "not-applicable")).toBe("skipped");
    }
    expect(await test.service.notify(identity, "purchased-compensation-required", "deferred"))
      .toBe("deferred");
    expect(await test.service.notify(identity, "released", "deferred")).toBe("deferred");
    expect(test.support.write).not.toHaveBeenCalled();
    expect(test.database.conversationMessage.findUnique).not.toHaveBeenCalled();
  });

  it("fails closed and is retryable when required 131026 suppression did not apply", async () => {
    const test = harness();
    await expect(test.service.notify(identity, "released", "not-applicable"))
      .rejects.toThrow("suppression is required");
    expect(test.support.write).not.toHaveBeenCalled();
  });

  it("supports a separately corrected non-recipient failure without claiming suppression", async () => {
    const test = harness("131047");
    await test.service.notify(identity, "historical-only", "not-applicable");
    const body = test.support.write.mock.calls[0]?.[0].body as string;
    expect(body).toContain("no spendable credit was added");
    expect(body).not.toContain("temporarily paused");
    await expect(test.service.notify(identity, "historical-only", "suppressed"))
      .rejects.toThrow("unexpected suppression");
  });

  it("supports held-for-refund wording without claiming a spendable restoration", async () => {
    const test = harness();
    await test.service.notify(identity, "held-for-refund", "suppressed");
    expect(test.support.write.mock.calls[0]?.[0].body).toContain("held for refund");
    expect(test.support.write.mock.calls[0]?.[0].body).not.toContain("available for another recovery");
  });

  it("skips unrelated/inbound/unowned rows and rejects cross-Shop mismatches", async () => {
    const test = harness();
    test.message.direction = "INBOUND";
    expect(await test.service.notify(identity, "released", "suppressed")).toBe("skipped");
    test.message.direction = "OUTBOUND";
    test.message.conversation.checkoutRecovery = null as never;
    expect(await test.service.notify(identity, "released", "suppressed")).toBe("skipped");
    test.message.conversation.checkoutRecovery = { id: "recovery-1", shopId: "other-shop" };
    await expect(test.service.notify(identity, "released", "suppressed"))
      .rejects.toThrow("conflicting Shop");
    expect(test.support.write).not.toHaveBeenCalled();
  });

  it("propagates support persistence failures for retry, without undoing correction", async () => {
    const test = harness();
    test.support.write.mockRejectedValueOnce(new Error("translation/database unavailable"));
    await expect(test.service.notify(identity, "released", "suppressed"))
      .rejects.toThrow("translation/database unavailable");
    await expect(test.service.notify(identity, "released", "suppressed"))
      .resolves.toBe("created");
    expect(test.support.write).toHaveBeenCalledTimes(2);
  });
});
