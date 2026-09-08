import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  InboundWhatsAppAbuseAdmissionService,
} from "../../../src/services/inbound-whatsapp-abuse-admission.service.js";

function phoneHash(phone: string): string {
  const normalized = phone.trim().startsWith("+")
    ? `+${phone.trim().replace(/\D/g, "")}`
    : phone.trim().replace(/\D/g, "");
  return createHash("sha256").update(normalized).digest("hex");
}

describe("InboundWhatsAppAbuseAdmissionService", () => {
  it("uses one atomic Redis operation and hashes sender keys", async () => {
    const redis = { eval: vi.fn().mockResolvedValue(0) };
    const service = new InboundWhatsAppAbuseAdmissionService(redis);

    await expect(
      service.admitRaw({
        providerMessageId: "wamid-1",
        customerPhone: "+44 (7700) 900000",
      }),
    ).resolves.toEqual({ kind: "allowed" });

    expect(redis.eval).toHaveBeenCalledTimes(1);
    const args = redis.eval.mock.calls[0] as unknown[];
    expect(args[1]).toBe(2);
    expect(args).toContain(
      `arch007:wa-abuse:v1:raw:sender:${phoneHash("+44 (7700) 900000")}:60s`,
    );
    expect(args.join(" ")).not.toContain("7700");
    expect(args.join(" ")).not.toContain("900000");
  });

  it("maps the atomic scope result to a bounded denial reason", async () => {
    const redis = { eval: vi.fn().mockResolvedValue(3) };
    const service = new InboundWhatsAppAbuseAdmissionService(redis);

    await expect(
      service.admitSettledTurn({
        conversationId: "conversation-1",
        observedVersion: 7,
        shopId: "shop-1",
        customerPhone: "+447700900000",
        conversationType: "PRODUCT_SUPPORT",
        hasReplyContext: false,
        checkoutRecoveryId: null,
      }),
    ).resolves.toEqual({
      kind: "denied",
      stage: "settled-turn",
      reason: "TURN_CONVERSATION_SHORT",
    });
  });

  it("fails closed when Redis cannot make a decision", async () => {
    const redis = { eval: vi.fn().mockRejectedValue(new Error("redis down")) };
    const service = new InboundWhatsAppAbuseAdmissionService(redis);

    await expect(
      service.admitRaw({
        providerMessageId: "wamid-1",
        customerPhone: "+447700900000",
      }),
    ).resolves.toEqual({
      kind: "denied",
      stage: "raw",
      reason: "LIMITER_UNAVAILABLE",
    });
  });

  it("uses discovery limits only without reply context", async () => {
    const redis = { eval: vi.fn().mockResolvedValue(0) };
    const service = new InboundWhatsAppAbuseAdmissionService(redis);

    await service.admitSettledTurn({
      conversationId: "conversation-1",
      observedVersion: 1,
      shopId: "shop-1",
      customerPhone: "+447700900000",
      conversationType: "PRODUCT_DISCOVERY",
      hasReplyContext: false,
      checkoutRecoveryId: null,
    });

    const args = redis.eval.mock.calls[0] as unknown[];
    expect(args).toContain("4");
    expect(args).toContain("12");
  });
});
