import { describe, expect, it } from "vitest";
import {
  isConfirmedProviderNonDelivery,
  outreachDeliveryFailureCode,
  classifyWhatsAppProviderFailure,
} from "../../../src/domain/whatsapp-recipient-failure.js";

const failed = {
  status: "FAILED",
  providerMessageId: "wamid.1",
  failedAt: new Date(),
  deliveredAt: null,
  readAt: null,
};

describe("definitive delivery failure evidence", () => {
  it("uses durable failure without requiring a reason code", () => {
    expect(isConfirmedProviderNonDelivery(failed)).toBe(true);
    expect(outreachDeliveryFailureCode(null)).toBe("WHATSAPP_DELIVERY_FAILED");
    expect(outreachDeliveryFailureCode("131049")).toBe(
      "WHATSAPP_DELIVERY_FAILED:131049",
    );
    expect(classifyWhatsAppProviderFailure("131049")).toBeNull();
    expect(classifyWhatsAppProviderFailure("131026")).toBe(
      "RECIPIENT_UNDELIVERABLE",
    );
  });
  it.each([
    { status: "PENDING" },
    { status: "SENT" },
    { status: "DELIVERED" },
    { status: "READ" },
    { providerMessageId: null },
    { failedAt: null },
    { deliveredAt: new Date() },
    { readAt: new Date() },
  ])("rejects incomplete or contradictory evidence %o", (overrides) => {
    expect(isConfirmedProviderNonDelivery({ ...failed, ...overrides })).toBe(
      false,
    );
  });
});
