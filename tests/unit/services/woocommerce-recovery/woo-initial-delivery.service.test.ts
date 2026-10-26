import { describe, expect, it, vi } from "vitest";
import { OutboundMessageDeliveryService } from "../../../../src/services/outbound-whatsapp-admission/outbound-message-delivery.service.js";

const wooScope = {
  recoveryId: "recovery-1", checkoutToken: "checkout-1", customerId: "customer-1", attemptId: "attempt-1",
  consent: { shopId: "shop-1", installationId: "install-1", credentialVersion: 1,
    customerId: "customer-1", customerPhoneId: "phone-1", canonicalRecipient: "447400123456",
    consentRevision: 2n, consentDecisionSequence: 2n, noContactRevision: 0n },
  idempotencyKey: "recovery-outreach:attempt-1", recoveryCreditSourceKey: "source-1",
};
const admission = { kind: "admitted" as const, shopId: "shop-1", conversationId: "conversation-1",
  messageId: "message-1", terminal: false, executionScope: "recovery" as const };
const template = { to: "+447400123456", templateName: "woo_recovery", languageCode: "en_GB" };

function harness(senderType: "AGENT" | "AUTOMATION" = "AUTOMATION") {
  let content = "[pending]";
  let status = "PENDING";
  const sendWhatsAppTemplate = vi.fn(async () => ({ providerMessageId: "wamid-1" }));
  const verify = vi.fn(async () => "MARKETING" as "MARKETING" | "UTILITY" | null);
  const admitFinalSend = vi.fn(async () => ({ kind: "admitted" as const }));
  const generalFence = { admitFinalSend: vi.fn(async () => ({
    kind: "suppressed" as const, reason: "local-no-contact",
  })) };
  const recoveryFence = { admitFinalSend: vi.fn(async () => ({
    kind: "suppressed" as const, reason: "local-no-contact",
  })) };
  const ownership = { readTurnOwnership: vi.fn(async () =>
    null as null | { recoveryId: string; revision: number }) };
  const failPrepared = vi.fn(async () => { status = "FAILED"; });
  const afterProviderError = vi.fn(async () => undefined);
  const findUnique = vi.fn(async () => ({ conversationId: "conversation-1",
    senderType, status, content,
    providerDispatchKey: null, providerDispatchAdmittedAt: null }));
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    if (typeof data.content === "string") content = data.content;
    if (data.status === "SENT") status = "SENT";
    return {};
  });
  const db = {
    conversationMessage: { findUnique, update },
    conversation: { update: vi.fn(async () => ({})) },
    usageEvent: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    $queryRawUnsafe: vi.fn(),
  };
  const moderation = {
    assessText: vi.fn(async () => ({ kind: "allow" as const })),
    requireCurrentAllowance: vi.fn(async () => true),
  };
  const service = new OutboundMessageDeliveryService(
    db as never,
    { sendWhatsAppTemplate, sendWhatsAppText: vi.fn(), getProviderAccountId: vi.fn() } as never,
    { evaluate: vi.fn(async () => ({ allowed: true })) } as never,
    ownership as never, recoveryFence as never, moderation as never,
    { failPrepared, afterProviderError } as never,
    generalFence as never, {} as never, { verify } as never,
    { admitFinalSend } as never,
  );
  return { service, sendWhatsAppTemplate, verify, admitFinalSend, failPrepared,
    afterProviderError, moderation, generalFence, recoveryFence, ownership,
    get content() { return content; } };
}

describe("ARCH-046 Woo prepared-template delivery reuses existing provider pipeline", () => {
  it("commits the dedicated permit before calling Meta, retaining one moderated prepared body", async () => {
    const f = harness(); const ordered: string[] = [];
    f.admitFinalSend.mockImplementationOnce(async () => {
      ordered.push("committed-final-permit");
      return { kind: "admitted" };
    });
    f.sendWhatsAppTemplate.mockImplementationOnce(async () => {
      ordered.push("meta"); return { providerMessageId: "wamid-1" };
    });
    expect((await f.service.sendPreparedWooInitialTemplate(admission, template, wooScope)).kind).toBe("admitted");
    expect(ordered).toEqual(["committed-final-permit", "meta"]);
    expect(f.verify).toHaveBeenCalledWith({
      providerTemplateName: "woo_recovery", providerLanguageCode: "en_GB",
    });
    expect(f.admitFinalSend).toHaveBeenCalledWith(expect.objectContaining({
      ...wooScope, shopId: "shop-1", conversationId: "conversation-1", messageId: "message-1",
      recipient: template.to, expectedContent: f.content, verifiedCategory: "MARKETING",
    }));
  });

  it("suppresses Utility/unknown Meta category without acquiring a SQL provider permit", async () => {
    for (const category of ["UTILITY", null] as const) {
      const f = harness(); f.verify.mockResolvedValueOnce(category);
      expect((await f.service.sendPreparedWooInitialTemplate(admission, template, wooScope)).kind)
        .toBe("suppressed");
      expect(f.admitFinalSend).not.toHaveBeenCalled();
      expect(f.sendWhatsAppTemplate).not.toHaveBeenCalled();
      expect(f.failPrepared).toHaveBeenCalledWith("message-1");
    }
  });

  it("suppresses STOP/consent denial and refunds unadmitted usage via existing failure adapter", async () => {
    const f = harness();
    f.admitFinalSend.mockResolvedValueOnce({ kind: "suppressed", reason: "woo-consent-changed" } as never);
    expect((await f.service.sendPreparedWooInitialTemplate(admission, template, wooScope)).kind)
      .toBe("suppressed");
    expect(f.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(f.failPrepared).toHaveBeenCalledWith("message-1");
  });

  it("preserves admission evidence on duplicate final permit, including uncertain provider outcome", async () => {
    const f = harness();
    f.admitFinalSend.mockResolvedValueOnce({ kind: "suppressed", reason: "already-admitted-or-sent" } as never);
    expect(await f.service.sendPreparedWooInitialTemplate(admission, template, wooScope))
      .toEqual({ kind: "suppressed", reason: "duplicate" });
    expect(f.failPrepared).not.toHaveBeenCalled();
    expect(f.sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("propagates technical moderation failure and cleans only pre-permit reservation", async () => {
    const f = harness(); f.moderation.assessText.mockRejectedValueOnce(new Error("moderation API unavailable"));
    await expect(f.service.sendPreparedWooInitialTemplate(admission, template, wooScope))
      .rejects.toThrow("moderation API unavailable");
    expect(f.failPrepared).toHaveBeenCalled();
    expect(f.admitFinalSend).not.toHaveBeenCalled();
  });

  it("never clears committed Woo provider idempotency on an uncertain error", async () => {
    const f = harness();
    f.sendWhatsAppTemplate.mockRejectedValueOnce(new Error("timeout"));
    await expect(f.service.sendPreparedWooInitialTemplate(admission, template, wooScope))
      .rejects.toThrow("timeout");
    expect(f.afterProviderError).toHaveBeenCalledWith("message-1", template.to,
      expect.any(Error), true);
    expect(f.failPrepared).not.toHaveBeenCalled();
  });

  it("never substitutes terminal TEXT after a hard-limit reservation", async () => {
    const f = harness();
    const result = await f.service.sendPreparedWooInitialTemplate({ ...admission, terminal: true }, template, wooScope);
    expect(result).toEqual({ kind: "suppressed", reason: "normal-cap-reached" });
    expect(f.failPrepared).toHaveBeenCalled();
    expect(f.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(f.admitFinalSend).not.toHaveBeenCalled();
  });

  it("preserves both original provider error and failed compensation for reconciliation", async () => {
    const f = harness();
    const original = new Error("provider timed out");
    const reconciliation = new Error("database unavailable");
    f.sendWhatsAppTemplate.mockRejectedValueOnce(original);
    f.afterProviderError.mockRejectedValueOnce(reconciliation);
    await expect(f.service.sendPreparedWooInitialTemplate(admission, template, wooScope))
      .rejects.toMatchObject({ name: "AggregateError", errors: [original, reconciliation] });
    expect(f.failPrepared).not.toHaveBeenCalled();
  });

  it("keeps ordinary HUMAN text on the general STOP fence, never the Woo permit", async () => {
    const f = harness("AGENT");
    const result = await f.service.sendPreparedText({
      ...admission, executionScope: "general", to: template.to, text: "Merchant reply",
    });
    expect(result).toEqual({ kind: "suppressed", reason: "conversation-invalid" });
    expect(f.generalFence.admitFinalSend).toHaveBeenCalledWith(expect.objectContaining({
      messageId: admission.messageId, conversationId: admission.conversationId,
      recipient: template.to, expectedContent: "Merchant reply",
    }));
    expect(f.recoveryFence.admitFinalSend).not.toHaveBeenCalled();
    expect(f.admitFinalSend).not.toHaveBeenCalled();
    expect(f.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(f.failPrepared).toHaveBeenCalledWith(admission.messageId);
  });

  it("keeps ordinary in-window AI recovery replies on their existing STOP/revision fence", async () => {
    const f = harness("AGENT");
    f.ownership.readTurnOwnership.mockResolvedValueOnce({ recoveryId: "recovery-1", revision: 3 });
    const result = await f.service.sendPreparedText({
      ...admission, executionScope: "recovery", to: template.to, text: "AI recovery reply",
      expectedControlRevision: 3,
    });
    expect(result).toEqual({ kind: "suppressed", reason: "conversation-invalid" });
    expect(f.recoveryFence.admitFinalSend).toHaveBeenCalledWith(expect.objectContaining({
      senderType: "AGENT", recoveryId: "recovery-1", expectedControlRevision: 3,
      recipient: template.to, deliveryKind: "TEXT",
    }));
    expect(f.generalFence.admitFinalSend).not.toHaveBeenCalled();
    expect(f.admitFinalSend).not.toHaveBeenCalled();
    expect(f.sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

});
