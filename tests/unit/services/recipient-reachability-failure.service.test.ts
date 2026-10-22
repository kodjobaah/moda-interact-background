import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/db.js", () => ({ default: {} }));
import { RecipientReachabilityFailureService } from
  "../../../src/services/recipient-reachability-failure.service.js";

const failureAt = new Date("2026-10-22T10:00:00Z");
const message = () => ({
  id: "message-1", conversationId: "conversation-1", direction: "OUTBOUND",
  senderType: "AUTOMATION", status: "FAILED", failedAt: failureAt,
  providerFailureCode: "131026",
  conversation: {
    shopId: null, checkoutRecovery: { id: "recovery-1", shopId: "shop-1" },
  },
  recoveryOutreachAttempt: {
    id: "attempt-1", checkoutRecoveryId: "recovery-1",
    outboundMessageId: "message-1", recipient: "447700900123",
  },
  merchantSendCommand: null,
});

function harness() {
  const current = message();
  const database = { conversationMessage: { findUnique: vi.fn().mockResolvedValue(current) } };
  const store = { recordFailure: vi.fn().mockResolvedValue("recorded") };
  const service = new RecipientReachabilityFailureService(database as never, store as never);
  return { current, database, store, service };
}

describe("ARCH-028 failure reachability after correction", () => {
  it.each(["released", "already-released", "restored-spendable", "historical-only"] as const)(
    "uses the durable attempt's Shop-scoped recipient after %s", async (correction) => {
      const h = harness();
      expect(await h.service.afterCorrection({ providerMessageId: "wamid-1" }, correction))
        .toBe("suppressed");
      expect(h.store.recordFailure).toHaveBeenCalledWith(
        "shop-1", "447700900123", failureAt, "131026",
      );
      h.store.recordFailure.mockResolvedValue("unchanged");
      expect(await h.service.afterCorrection({ providerMessageId: "wamid-1" }, correction))
        .toBe("unchanged");
    },
  );

  it("never writes when committed purchased correction is deferred", async () => {
    const h = harness();
    expect(await h.service.afterCorrection({ providerMessageId: "wamid-1" },
      "purchased-compensation-required")).toBe("deferred");
    expect(h.store.recordFailure).not.toHaveBeenCalled();
  });

  it.each(["not-terminal", "not-recovery"] as const)(
    "skips unapproved correction %s", async (result) => {
      const h = harness();
      expect(await h.service.afterCorrection({ providerMessageId: "wamid-1" }, result))
        .toBe("not-applicable");
      expect(h.store.recordFailure).not.toHaveBeenCalled();
    },
  );

  it("never suppresses another provider failure even if credited under later policy", async () => {
    const h = harness();
    h.current.providerFailureCode = "131047";
    expect(await h.service.afterCorrection({ providerMessageId: "wamid-1" },
      "restored-spendable")).toBe("not-applicable");
    expect(h.store.recordFailure).not.toHaveBeenCalled();
  });

  it("uses messageId for synchronous correction without fabricating a provider ID", async () => {
    const h = harness();
    expect(await h.service.afterCorrection({ messageId: "message-1" }, "released"))
      .toBe("suppressed");
    expect(h.database.conversationMessage.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "message-1" },
    }));
  });

  it("fails closed for conflicting Shop and attempt lineage", async () => {
    const h = harness();
    h.current.conversation.shopId = "shop-2";
    await expect(h.service.afterCorrection({ messageId: "message-1" }, "released"))
      .rejects.toThrow(/lineage/);
    expect(h.store.recordFailure).not.toHaveBeenCalled();
  });

  it("does not use a changed legacy Customer phone in place of the snapshot", async () => {
    const h = harness();
    h.current.recoveryOutreachAttempt.recipient = "447700900987";
    await h.service.afterCorrection({ messageId: "message-1" }, "released");
    expect(h.store.recordFailure).toHaveBeenCalledWith(
      "shop-1", "447700900987", failureAt, "131026",
    );
  });

  it("won't write a recipient when there is no exact attempt", async () => {
    const h = harness();
    h.current.recoveryOutreachAttempt = null as never;
    await expect(h.service.afterCorrection({ messageId: "message-1" }, "released"))
      .rejects.toThrow(/lineage/);
    expect(h.store.recordFailure).not.toHaveBeenCalled();
  });
});
