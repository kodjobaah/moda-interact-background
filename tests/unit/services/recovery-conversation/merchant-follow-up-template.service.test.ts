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
