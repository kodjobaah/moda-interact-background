import { describe, expect, it } from "vitest";
import { PlatformConfigurationFailure } from "../../../../src/services/platform-configuration/errors.js";
import { WhatsAppServiceError } from "../../../../src/services/whatsapp.service.js";
import { safeHumanSendErrorMessage } from "../../../../src/services/recovery-conversation/human-send-operational-incident.service.js";

describe("ARCH-040 actionable HUMAN send incident diagnostics", () => {
  it("retains the actual trusted sender configuration error and exact key", () => {
    expect(safeHumanSendErrorMessage(new PlatformConfigurationFailure("MISSING", "messaging.sender"), "test"))
      .toBe("PlatformConfigurationFailure: Platform configuration missing (key=messaging.sender; code=MISSING)");
  });
  it("retains static WhatsApp errors in every environment", () => {
    expect(safeHumanSendErrorMessage(new WhatsAppServiceError("configuration-missing", "WhatsApp configuration is missing"), "production"))
      .toContain("WhatsApp configuration is missing");
  });
  it("caps and redacts development exceptions, omits untrusted production errors", () => {
    const error = new Error("Bearer token123 accessToken=example-secret https://secret.example/abc some@example.com +447437107007 " + "x".repeat(600));
    const message = safeHumanSendErrorMessage(error, "test");
    expect(message.length).toBeLessThanOrEqual(512);
    expect(message).toContain("Bearer [redacted]");
    expect(message).toContain("accessToken=[redacted]");
    expect(message).not.toContain("token123");
    expect(message).not.toContain("example-secret");
    expect(message).not.toContain("secret.example");
    expect(message).not.toContain("some@example.com");
    expect(message).not.toContain("447437107007");
    expect(message).not.toContain("\n");
    expect(safeHumanSendErrorMessage(error, "production"))
      .toBe("Unexpected provider-dispatch exception; raw message omitted in this environment");
  });
});
