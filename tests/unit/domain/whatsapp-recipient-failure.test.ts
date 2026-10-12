import { describe, expect, it } from "vitest";
import { classifyWhatsAppProviderFailure } from "../../../src/domain/whatsapp-recipient-failure.js";

describe("classifyWhatsAppProviderFailure", () => {
  it("classifies only the exact terminal recipient provider code", () => {
    expect(classifyWhatsAppProviderFailure("131026")).toBe("RECIPIENT_UNDELIVERABLE");
    expect(classifyWhatsAppProviderFailure(" 131026 ")).toBeNull();
    expect(classifyWhatsAppProviderFailure("1310260")).toBeNull();
    expect(classifyWhatsAppProviderFailure("131047")).toBeNull();
    expect(classifyWhatsAppProviderFailure(null)).toBeNull();
    expect(classifyWhatsAppProviderFailure(undefined)).toBeNull();
  });
});