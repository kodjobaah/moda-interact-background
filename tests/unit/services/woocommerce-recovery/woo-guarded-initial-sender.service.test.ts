import { describe, expect, it, vi } from "vitest";
import { createRecoveryIdempotencyKey } from "@modainteract/moda-interact-shared/billing";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import { WooGuardedInitialSenderService } from "../../../../src/services/woocommerce-recovery/woo-guarded-initial-sender.service.js";

const logger = { child() { return this; }, warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as StructuredLogger;
const attemptId = "woo-attempt-1";
const idempotencyKey = `recovery-outreach:${attemptId}`;
const recoveryCreditSourceKey = createRecoveryIdempotencyKey("shop-1", idempotencyKey);
const input = {
  recovery: { id: "recovery-1", shopId: "shop-1", checkoutToken: "checkout-1",
    customerId: "customer-1", status: "DETECTED" as const, completedAt: null,
    shop: { status: "ACTIVE", platform: "WOOCOMMERCE" } },
  attemptId, conversationId: "conversation-1", recipient: "+447400123456",
  consent: { shopId: "shop-1", installationId: "install", credentialVersion: 1,
    customerId: "customer-1", customerPhoneId: "phone-1", canonicalRecipient: "447400123456",
    consentRevision: 1n, consentDecisionSequence: 1n, noContactRevision: 0n },
  template: { name: "woo_recovery", languageCode: "en_GB", canonicalLanguageTag: "en-GB",
    verifiedCategory: "MARKETING" as const,
    sendFields: { templateName: "woo_recovery", languageCode: "en_GB", bodyParameters: ["Hello"],
      templateRegistration: { shopId: "shop-1", purpose: "INITIAL_NO_OFFER",
        senderWabaId: "waba-1", variantId: "v-1", registrationId: "r-1",
        definitionId: "d-1", providerTemplateId: "meta-1",
        providerTemplateName: "woo_recovery", providerLanguageCode: "en_GB",
        submittedContentHash: "a".repeat(64), bindingFingerprint: "a".repeat(64) } }, },
  idempotencyKey, recoveryCreditSourceKey,
};

function harness() {
  const read = vi.fn(async () => ({ kind: "none-observed" as const }));
  const findExistingAdmission = vi.fn(async () => null as null | {
    id: string; conversationId: string; status: string; sentAt: Date | null;
  });
  const reserve = vi.fn(async () => ({ kind: "admitted" as const, shopId: "shop-1",
    messageId: "message-1", conversationId: "conversation-1", terminal: false }));
  const sendPreparedWooInitialTemplate = vi.fn(async () => ({ kind: "admitted" as const,
    shopId: "shop-1", conversationId: "conversation-1", messageId: "message-1", terminal: false }));
  const service = new WooGuardedInitialSenderService({ read }, logger,
    { findExistingAdmission, reserve } as never, { sendPreparedWooInitialTemplate } as never);
  return { read, findExistingAdmission, reserve, sendPreparedWooInitialTemplate, service };
}

describe("ARCH-046-BACKGROUND-004 Woo initial sender adapter", () => {
  it("uses one existing outbound reservation and an injected Woo-only delivery permit", async () => {
    const f = harness();
    expect(await f.service.sendInitial(input)).toEqual({ kind: "admitted" });
    expect(f.reserve).toHaveBeenCalledWith({
      shopId: "shop-1", conversationId: "conversation-1", senderType: "AUTOMATION",
      idempotencyKey, recoveryCreditSourceKey,
    });
    expect(f.sendPreparedWooInitialTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "message-1" }),
      { ...input.template.sendFields, to: input.recipient },
      expect.objectContaining({ recoveryId: "recovery-1", attemptId, consent: input.consent }),
    );
  });

  it("rejects terminal, ambiguous or unavailable order evidence before reservation", async () => {
    const f = harness();
    f.read.mockResolvedValueOnce({ kind: "order-paid", orderId: "order-1" } as never);
    expect(await f.service.sendInitial(input)).toEqual({ kind: "suppressed", reason: "woo-observed-order-terminal" });
    f.read.mockResolvedValueOnce({ kind: "ambiguous", reason: "different-order-id" } as never);
    await expect(f.service.sendInitial(input)).rejects.toThrow("WOO_ORDER_EVIDENCE_AMBIGUOUS");
    f.read.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(f.service.sendInitial(input)).rejects.toThrow("redis unavailable");
    expect(f.reserve).not.toHaveBeenCalled();
  });

  it("rejects cross-tenant reuse, changed recipient, invalid template and credit source", async () => {
    const f = harness();
    for (const tampered of [
      { ...input, idempotencyKey: "recovery-outreach:other" },
      { ...input, recoveryCreditSourceKey: "different" },
      { ...input, recipient: "+447400654321" },
      { ...input, consent: { ...input.consent, customerId: "different" } },
      { ...input, recovery: { ...input.recovery, shop: { status: "SUSPENDED", platform: "WOOCOMMERCE" } } },
    ]) {
      expect((await f.service.sendInitial(tampered)).kind).toBe("suppressed");
    }
    expect(f.read).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
  });

  it("never re-sends an existing confirmed, pending, or failed provider admission", async () => {
    const f = harness();
    f.findExistingAdmission.mockResolvedValueOnce({ id: "m", conversationId: "conversation-1",
      status: "SENT", sentAt: new Date() });
    expect(await f.service.sendInitial(input)).toEqual({ kind: "suppressed", reason: "duplicate" });
    f.findExistingAdmission.mockResolvedValueOnce({ id: "m", conversationId: "conversation-1",
      status: "PENDING", sentAt: null });
    await expect(f.service.sendInitial(input)).rejects.toThrow("WOO_INITIAL_PROVIDER_OUTCOME_UNCERTAIN");
    f.findExistingAdmission.mockResolvedValueOnce({ id: "m", conversationId: "conversation-1",
      status: "FAILED", sentAt: null });
    expect(await f.service.sendInitial(input)).toEqual({ kind: "suppressed", reason: "duplicate" });
    f.findExistingAdmission.mockResolvedValueOnce({ id: "m", conversationId: "other",
      status: "SENT", sentAt: new Date() });
    await expect(f.service.sendInitial(input)).rejects.toThrow("OWNERSHIP_MISMATCH");
    expect(f.reserve).not.toHaveBeenCalled();
  });

  it("logs bounded exception identity via the shared logger and rethrows unchanged", async () => {
    const f = harness();
    const error = Object.assign(new Error("recipient +447400123456 must remain private"), { code: "P1001" });
    f.sendPreparedWooInitialTemplate.mockRejectedValueOnce(error);
    await expect(f.service.sendInitial(input)).rejects.toBe(error);
    expect(logger.error).toHaveBeenCalledWith("woocommerce.recovery.initial.permit.failed", {
      shopId: "shop-1", recoveryId: "recovery-1", attemptId,
      errorName: "Error", errorCode: "P1001",
      errorMessage: error.message, error,
    });
    expect((logger.error as ReturnType<typeof vi.fn>).mock.lastCall?.[1].errorMessage).toContain("447400123456");
  });
});
