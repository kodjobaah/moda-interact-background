import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  TERMINAL_MESSAGE,
  runCommerceAgentAfterAdmission,
} from "../../../src/services/outbound-whatsapp-admission.service.js";
import { EffectiveBillingPolicyError } from "../../../src/services/effective-billing-policy.service.js";
import {
  admissionHarness,
  baseAdmissionInput,
} from "./outbound-whatsapp-admission/outbound-admission.test-support.js";

const textInput = {
  ...baseAdmissionInput,
  to: "+15551234567",
  text: "Hello",
};

describe("OutboundWhatsAppAdmissionService", () => {
  it("keeps low-level WhatsApp transport imports inside the admission boundary", () => {
    for (const relativePath of [
      "src/workers/whatsapp.worker.ts",
      "src/services/checkout-recovery.service.ts",
    ]) {
      const source = readFileSync(resolve(process.cwd(), relativePath), "utf8");
      expect(source).not.toMatch(/from ["'][.\/]+whatsapp\.service\.js["']/);
      expect(source).not.toMatch(/whatsAppService\.sendWhatsApp(?:Text|Template)/);
    }
  });

  it("persists durable intent before provider delivery", async () => {
    const test = admissionHarness();

    const result = await test.facade.sendText(textInput);

    expect(result).toMatchObject({
      kind: "admitted",
      shopId: "shop-1",
      terminal: false,
    });
    expect(test.transaction.conversationMessage.create).toHaveBeenCalledBefore(
      test.providerMock.sendWhatsAppText,
    );
    expect(test.providerMock.sendWhatsAppText).toHaveBeenCalledWith({
      to: textInput.to,
      text: textInput.text,
    });
    expect(test.messages.get("message-1")).toMatchObject({
      status: "SENT",
      content: "Hello",
    });
  });

  it("composes post-contract durable recovery admission with recovery-scoped delivery", async () => {
    const test = admissionHarness({
      recoveryLinked: true,
      durableReservation: {
        shopId: "shop-1",
        status: "RESERVED",
        counter: { counter: "PURCHASED_RECOVERY_CREDITS" },
      },
    });
    test.resolver.resolve.mockRejectedValueOnce(
      new EffectiveBillingPolicyError("NO_CONTRACT", "contract ended"),
    );

    const result = await test.facade.sendTemplate({
      ...baseAdmissionInput,
      idempotencyKey: "recovery-outreach:attempt-1",
      recoveryCreditSourceKey: "recovery:shop-1:attempt-1",
      senderType: "AUTOMATION",
      to: "+15551234567",
      templateName: "recovery",
      languageCode: "en",
    });

    expect(result).toMatchObject({ kind: "admitted", executionScope: "recovery" });
    expect(test.postContractResolver.resolve).toHaveBeenCalledWith("shop-1");
    expect(test.executionEligibility.evaluate).toHaveBeenCalledWith(
      "shop-1",
      undefined,
      "recovery",
    );
    expect(test.providerMock.sendWhatsAppTemplate).toHaveBeenCalledOnce();
  });

  it("composes terminal admission with deterministic text instead of template transport", async () => {
    const test = admissionHarness({
      usageRows: [
        { sourceType: "OUTBOUND_AUTOMATED_MESSAGE", quantity: 2 },
      ],
    });

    await test.facade.sendTemplate({
      ...baseAdmissionInput,
      idempotencyKey: "terminal-template",
      to: "+15551234567",
      templateName: "recovery",
      languageCode: "en",
    });

    expect(test.providerMock.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(test.providerMock.sendWhatsAppText).toHaveBeenCalledWith({
      to: "+15551234567",
      text: TERMINAL_MESSAGE,
    });
  });

  it("does not invoke CommerceAgent for a terminal admission", async () => {
    const runAgent = vi.fn().mockResolvedValue({ replyText: "ordinary reply" });
    const sendPreparedText = vi.fn().mockResolvedValue({
      kind: "admitted",
      shopId: "shop-1",
      messageId: "message-1",
      conversationId: "conversation-1",
      terminal: true,
    });
    const admission = {
      kind: "admitted" as const,
      shopId: "shop-1",
      messageId: "message-1",
      conversationId: "conversation-1",
      terminal: true,
    };

    await expect(
      runCommerceAgentAfterAdmission({
        admission,
        to: "+15551234567",
        context: { recovery: true },
        runAgent,
        sendPreparedText,
        failPrepared: vi.fn(),
      }),
    ).resolves.toBeNull();

    expect(runAgent).not.toHaveBeenCalled();
    expect(sendPreparedText).toHaveBeenCalledWith({
      ...admission,
      to: "+15551234567",
      text: TERMINAL_MESSAGE,
    });
  });

  it("fails the prepared durable intent when CommerceAgent fails before provider delivery", async () => {
    const failure = new Error("agent failed");
    const failPrepared = vi.fn().mockResolvedValue(undefined);
    const admission = {
      kind: "admitted" as const,
      shopId: "shop-1",
      messageId: "message-1",
      conversationId: "conversation-1",
      terminal: false,
    };

    await expect(
      runCommerceAgentAfterAdmission({
        admission,
        to: "+15551234567",
        context: { recovery: false },
        runAgent: vi.fn().mockRejectedValue(failure),
        sendPreparedText: vi.fn(),
        failPrepared,
      }),
    ).rejects.toThrow("agent failed");

    expect(failPrepared).toHaveBeenCalledWith("message-1");
  });
});
