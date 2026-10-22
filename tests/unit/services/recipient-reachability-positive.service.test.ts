import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/db.js", () => ({ default: {} }));
import { RecipientReachabilityPositiveService } from
  "../../../src/services/recipient-reachability-positive.service.js";

const at = new Date("2026-10-22T11:00:00.000Z");
const outbound = () => ({
  id: "outbound-1", direction: "OUTBOUND", status: "READ", senderType: "AUTOMATION",
  deliveredAt: at, readAt: at, failedAt: null,
  conversation: { shopId: null, checkoutRecovery: { id: "recovery-1", shopId: "shop-1" } },
  recoveryOutreachAttempt: {
    id: "attempt-1", checkoutRecoveryId: "recovery-1", outboundMessageId: "outbound-1", recipient: "15551234567",
  },
  merchantSendCommand: null,
});
const inbound = () => ({
  conversationId: "conversation-1", direction: "INBOUND", senderType: "CUSTOMER", createdAt: at,
  conversation: { shopId: null, checkoutRecovery: { shopId: "shop-1" } },
});
function harness(row: unknown) {
  const database = { conversationMessage: { findUnique: vi.fn().mockResolvedValue(row) } };
  const store = { recordSuccess: vi.fn().mockResolvedValue("recorded") };
  return { database, store, service: new RecipientReachabilityPositiveService(
    database as never, store as never,
  ) };
}

describe("ARCH-028 recipient positive evidence", () => {
  it.each(["DELIVERED", "READ"] as const)("records %s for exact attempt recipient", async (status) => {
    const message = { ...outbound(), status, readAt: status === "READ" ? at : null };
    const h = harness(message);
    expect(await h.service.fromProviderDelivery("wamid-1")).toBe("recorded");
    expect(h.store.recordSuccess).toHaveBeenCalledWith("shop-1", "15551234567", at);
  });

  it("skips earlier statuses and absent recovery attempts", async () => {
    const message = { ...outbound(), status: "SENT" };
    const h = harness(message);
    expect(await h.service.fromProviderDelivery("wamid-1")).toBe("not-applicable");
    expect(h.store.recordSuccess).not.toHaveBeenCalled();
    message.status = "READ";
    message.recoveryOutreachAttempt = null as never;
    expect(await h.service.fromProviderDelivery("wamid-1")).toBe("not-applicable");
  });

  it("clears only the routed inbound Shop and canonical recipient", async () => {
    const h = harness(inbound());
    const input = { shopId: "shop-1", conversationId: "conversation-1",
      providerMessageId: "inbound-1", customerPhone: "+15551234567" };
    expect(await h.service.fromRoutedInbound(input)).toBe("recorded");
    expect(h.store.recordSuccess).toHaveBeenCalledWith("shop-1", "15551234567", at);
    await expect(h.service.fromRoutedInbound({ ...input, shopId: "shop-2" }))
      .resolves.toBe("not-applicable");
    expect(h.store.recordSuccess).toHaveBeenCalledTimes(1);
  });

  it("does not clear a contextless or unpersisted inbound", async () => {
    const h = harness(null);
    const result = await h.service.fromRoutedInbound({
      shopId: "shop-1", conversationId: "conversation-1",
      providerMessageId: "unknown", customerPhone: "+15551234567",
    });
    expect(result).toBe("not-applicable");
    expect(h.store.recordSuccess).not.toHaveBeenCalled();
  });

  it("does not clear a different conversation or spoofed inbound direction", async () => {
    const row = inbound();
    const h = harness(row);
    const args = { shopId: "shop-1", conversationId: "wrong-conversation",
      providerMessageId: "inbound-1", customerPhone: "15551234567" };
    expect(await h.service.fromRoutedInbound(args)).toBe("not-applicable");
    row.direction = "OUTBOUND";
    expect(await h.service.fromRoutedInbound({ ...args,
      conversationId: "conversation-1" })).toBe("not-applicable");
    expect(h.store.recordSuccess).not.toHaveBeenCalled();
  });
});
