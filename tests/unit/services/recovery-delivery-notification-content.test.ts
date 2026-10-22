import { describe, expect, it } from "vitest";
import {
  recoveryDeliveryNoticeBody,
  recoveryDeliveryNoticeSourceKey,
} from "../../../src/services/recovery-delivery-notification-content.js";

describe("ARCH-028-BACKGROUND-008 merchant notification content", () => {
  it("uses the exact durable Shop/recovery/message identity without unbounded content", () => {
    const source = recoveryDeliveryNoticeSourceKey("shop-1", "recovery-1", "message-1");
    expect(source).toBe(recoveryDeliveryNoticeSourceKey("shop-1", "recovery-1", "message-1"));
    expect(source).not.toBe(recoveryDeliveryNoticeSourceKey("shop-2", "recovery-1", "message-1"));
    expect(source).not.toBe(recoveryDeliveryNoticeSourceKey("shop-1", "recovery-2", "message-1"));
    expect(source).not.toBe(recoveryDeliveryNoticeSourceKey("shop-1", "recovery-1", "message-2"));
    expect(source.length).toBeLessThan(255);
    expect(source).not.toContain("shop-1");
  });

  it.each([
    ["released", "was released", false],
    ["already-released", "already been released", false],
    ["restored-spendable", "available for another recovery", true],
    ["historical-only", "no spendable credit was added", false],
    ["held-for-refund", "held for refund", false],
  ] as const)("describes %s accurately", (kind, expected, spendable) => {
    const body = recoveryDeliveryNoticeBody(kind, false);
    expect(body).toContain(expected);
    expect(body.includes("available for another recovery")).toBe(spendable);
    expect(body).not.toContain("131026");
    expect(body).not.toContain("447700900001");
    expect(body.length).toBeLessThan(450);
  });

  it("only mentions recipient pause when suppression actually occurred", () => {
    expect(recoveryDeliveryNoticeBody("released", true)).toContain("temporarily paused");
    expect(recoveryDeliveryNoticeBody("released", false)).not.toContain("temporarily paused");
  });
});
