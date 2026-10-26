import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));

import { MerchantFollowUpTemplateService } from
  "../../../../src/services/recovery-conversation/merchant-follow-up-template.service.js";
import type { HumanCommand } from
  "../../../../src/services/recovery-conversation/merchant-send-command.service.js";

const identity = {
  shopId: "shop-1", senderWabaId: "waba-1", purpose: "FOLLOW_UP_NO_OFFER" as const,
  variantId: "v1", registrationId: "r1", definitionId: "d1",
  providerTemplateId: "123", providerTemplateName: "moda_follow_up",
  providerLanguageCode: "en_GB", submittedContentHash: "a".repeat(64),
  bindingFingerprint: "a".repeat(64),
};
const command: HumanCommand = {
  id: "cmd1", idempotencyKey: "merchant:cmd1", shopId: "shop-1", conversationId: "conv1",
  kind: "RECOVERY_FOLLOW_UP_TEMPLATE", state: "CLAIMED", leaseToken: "lease1",
  leaseExpiresAt: new Date(Date.now() + 60_000), expectedControlRevision: 1,
  recipientSnapshot: "447700900001", textBody: null, templateName: "moda_follow_up",
  templateLanguageCode: "en_GB", templateParameters: [],
  recoveryOutreachAttemptId: "a1", outboundMessageId: null, providerDispatchKey: null,
};

function fixture() {
  const conversation = { shopId: "shop-1", checkoutRecoveryId: "recovery1", languageTag: "fr" };
  const database = { conversation: { findUnique: vi.fn(async () => conversation) } };
  const policy = { resolve: vi.fn(async () => ({ recoveryOfferMode: "NONE" })) };
  const prepared = {
    kind: "prepared" as const,
    prepared: { purpose: "FOLLOW_UP_NO_OFFER", shopId: "shop-1",
      senderWabaId: "waba-1", variantId: "v1", registrationId: "r1",
      definitionId: "d1", providerTemplateId: "123", submittedContentHash: "a".repeat(64),
      bindingFingerprint: "a".repeat(64),
      providerTemplateName: "moda_follow_up", providerLanguageCode: "en_GB" },
    send: { templateName: "moda_follow_up", languageCode: "en_GB", templateRegistration: identity,
      recoveryPromise: { kind: "NO_OFFER" }, bodyParameters: ["customer-first-name"],
      dynamicUrlButton: { index: 0, text: "trusted-checkout-token" },
      imageHeader: { link: "https://cdn.example.test/ready-r2.jpg" },
    },
  };
  const templates = { prepare: vi.fn(async () => prepared) };
  const log = { warn: vi.fn(), error: vi.fn() };
  const resolver = new MerchantFollowUpTemplateService(
    database as never, policy as never, templates as never, log,
  );
  return { resolver, templates, policy, database, conversation, prepared, log };
}

describe("ARCH-047 BG007 merchant post-window template selection", () => {
  it("prepares the current FOLLOW_UP purpose and conversation language from trusted tenant state", async () => {
    const f = fixture();
    const resolved = await f.resolver.resolve(command, "recovery1");
    expect(resolved).toEqual(f.prepared);
    expect(f.templates.prepare).toHaveBeenCalledWith(expect.objectContaining({
      shopId: "shop-1", recoveryId: "recovery1", stage: "FOLLOW_UP",
      conversationLanguageTag: "fr",
    }));
    expect(f.database.conversation.findUnique).toHaveBeenCalledWith({
      where: { id: "conv1" },
      select: { shopId: true, checkoutRecoveryId: true, languageTag: true },
    });
  });

  it.each([
    { templateName: "outside-meta-template" }, { templateLanguageCode: "de_DE" },
    { templateParameters: ["20% discount"] },
    { templateParameters: { header: "attacker-image" } },
  ])("rejects a merchant-selected untrusted template/parameter override %j", async (override) => {
    const f = fixture();
    expect(await f.resolver.resolve({ ...command, ...override }, "recovery1"))
      .toEqual({ kind: "unavailable", reason: "template_not_allowed" });
    if ("templateParameters" in override) expect(f.templates.prepare).not.toHaveBeenCalled();
  });

  it.each([
    { shopId: "other-shop" }, { checkoutRecoveryId: "other-recovery" },
  ])("rejects wrong tenant/recovery association %j", async (override) => {
    const f = fixture();
    f.database.conversation.findUnique.mockResolvedValue({ ...f.conversation, ...override });
    const resolved = await f.resolver.resolve(command, "recovery1");
    expect(resolved).toEqual({ kind: "unavailable", reason: "template_not_allowed" });
    expect(f.templates.prepare).not.toHaveBeenCalled();
  });

  it("rejects stale or unavailable assignments (including READY media and CTA failures)", async () => {
    const f = fixture();
    f.templates.prepare.mockResolvedValue({ kind: "unavailable", reason: "MEDIA_NOT_READY" } as never);
    expect(await f.resolver.resolve(command, "recovery1"))
      .toEqual({ kind: "unavailable", reason: "follow_up_unavailable" });
    expect(f.log.warn).toHaveBeenCalledWith(expect.any(String),
      expect.objectContaining({ reason: "MEDIA_NOT_READY" }));
  });

  it("refuses unverified positive offers when FIXED/AI offer evidence is unavailable", async () => {
    const f = fixture();
    f.policy.resolve.mockResolvedValue({ recoveryOfferMode: "FIXED" } as never);
    expect(await f.resolver.resolve(command, "recovery1"))
      .toEqual({ kind: "unavailable", reason: "follow_up_unavailable" });
  });

  it("rejects an initial-purpose registration returned by a faulty injected preparer", async () => {
    const f = fixture();
    f.templates.prepare.mockResolvedValue({ ...f.prepared,
      prepared: { ...f.prepared.prepared, purpose: "INITIAL_NO_OFFER" },
    } as never);
    expect(await f.resolver.resolve(command, "recovery1"))
      .toEqual({ kind: "unavailable", reason: "template_not_allowed" });
  });

  it.each([
    { textBody: "merchant-injected-text" },
    { recoveryOutreachAttemptId: null },
    { templateParameters: [{ type: "image", link: "https://attacker.invalid/image" }] },
    { templateParameters: { button: "https://attacker.invalid/checkout" } },
  ])("rejects unsupported command content before any policy/provider read %j", async (override) => {
    const f = fixture();
    expect(await f.resolver.resolve({ ...command, ...override }, "recovery1"))
      .toEqual({ kind: "unavailable", reason: "template_not_allowed" });
    expect(f.database.conversation.findUnique).not.toHaveBeenCalled();
    expect(f.policy.resolve).not.toHaveBeenCalled();
    expect(f.templates.prepare).not.toHaveBeenCalled();
  });

  it.each([
    { dynamicUrlButton: undefined },
    { dynamicUrlButton: { index: 0, text: "" } },
    { dynamicUrlButton: { index: 1, text: "checkout-suffix" } },
    { dynamicUrlButton: { index: 0, text: "checkout-suffix" }, textHeader: "untrusted header" },
    { imageHeader: null },
    { imageHeader: undefined, textHeader: "" },
  ])("refuses a missing or inconsistent frozen checkout CTA/header %j", async (override) => {
    const f = fixture();
    f.templates.prepare.mockResolvedValue({ ...f.prepared,
      send: { ...f.prepared.send, ...override },
    } as never);
    expect(await f.resolver.resolve(command, "recovery1"))
      .toEqual({ kind: "unavailable", reason: "follow_up_unavailable" });
  });

  it.each([
    { senderWabaId: "wrong-waba" },
    { providerTemplateName: "unexpected_name" },
    { providerLanguageCode: "es_ES" },
    { registrationId: "different-registration" },
    { submittedContentHash: "b".repeat(64) },
  ])("refuses a forged/faulty registration identity %j", async (override) => {
    const f = fixture();
    f.templates.prepare.mockResolvedValue({ ...f.prepared,
      send: { ...f.prepared.send,
        templateRegistration: { ...f.prepared.send.templateRegistration, ...override },
      },
    } as never);
    expect(await f.resolver.resolve(command, "recovery1"))
      .toEqual({ kind: "unavailable", reason: "template_not_allowed" });
  });

  it("forwards the exact prepared image/body/checkout components without recomposition", async () => {
    const f = fixture();
    const chosen = await f.resolver.resolve(command, "recovery1");
    expect(chosen.kind).toBe("prepared");
    if (chosen.kind !== "prepared") throw new Error("expected frozen prepared payload");
    expect(chosen.send).toBe(f.prepared.send);
    expect(chosen.send.imageHeader).toEqual({ link: "https://cdn.example.test/ready-r2.jpg" });
    expect(chosen.send.bodyParameters).toEqual(["customer-first-name"]);
    expect(chosen.send.dynamicUrlButton).toEqual({ index: 0, text: "trusted-checkout-token" });
  });

  it("emits bounded shared-logger refusals without merchant-provided parameter contents", async () => {
    const f = fixture();
    const attackerData = { header: "https://secret.invalid/customer-raw-image" };
    const result = await f.resolver.resolve({ ...command, templateParameters: attackerData }, "recovery1");
    expect(result).toEqual({ kind: "unavailable", reason: "template_not_allowed" });
    expect(f.log.warn).toHaveBeenCalledWith("arch047.merchant_follow_up.refused", {
      commandId: command.id, shopId: command.shopId, reason: "template_not_allowed",
    });
    expect(JSON.stringify(f.log.warn.mock.calls)).not.toContain(attackerData.header);
  });

  it("does not swallow database exceptions or convert them into a silent no-send decision", async () => {
    const f = fixture();
    const failure = new Error("raw database connection string must not be logged");
    f.database.conversation.findUnique.mockRejectedValue(failure);
    await expect(f.resolver.resolve(command, "recovery1")).rejects.toBe(failure);
    expect(f.templates.prepare).not.toHaveBeenCalled();
    expect(f.log.error).toHaveBeenCalledWith("arch047.merchant_follow_up.prepare_failed", {
      commandId: command.id, shopId: command.shopId, errorType: "Error",
    });
    expect(JSON.stringify(f.log.error.mock.calls)).not.toContain(failure.message);
  });

  it("preserves a frozen text header with its original checkout suffix", async () => {
    const f = fixture();
    const preparedSend = { ...f.prepared.send, imageHeader: undefined,
      textHeader: "Resolved shop name", dynamicUrlButton: { index: 0, text: "bound-checkout-suffix" } };
    f.templates.prepare.mockResolvedValue({ ...f.prepared, send: preparedSend } as never);
    const selected = await f.resolver.resolve(command, "recovery1");
    expect(selected.kind).toBe("prepared");
    if (selected.kind !== "prepared") throw new Error("expected frozen prepared template");
    expect(selected.send).toBe(preparedSend);
    expect(selected.send.textHeader).toBe("Resolved shop name");
    expect(selected.send.dynamicUrlButton?.text).toBe("bound-checkout-suffix");
  });

  it("logs a bounded exception type through the shared logger and rethrows", async () => {
    const f = fixture();
    const failure = new Error("secret provider body");
    f.templates.prepare.mockRejectedValue(failure);
    await expect(f.resolver.resolve(command, "recovery1")).rejects.toBe(failure);
    expect(f.log.error).toHaveBeenCalledWith("arch047.merchant_follow_up.prepare_failed", {
      commandId: "cmd1", shopId: "shop-1", errorType: "Error",
    });
    expect(JSON.stringify(f.log.error.mock.calls)).not.toContain("secret provider body");
  });
});
