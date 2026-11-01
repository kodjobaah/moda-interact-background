import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InitialNoOfferFallbackService,
  type InitialFallbackTrigger,
} from "../../../../src/services/recovery-template-integration/initial-no-offer-fallback.service.js";
import type { PreparedRecoveryTemplate } from
  "../../../../src/services/recovery-template-preparation/recovery-template.types.js";

const now = new Date("2026-10-26T09:00:00.000Z");
const checkoutUrl = "https://shop.test/checkouts/original?token=exact%2Fvalue";
const preparedTemplate: PreparedRecoveryTemplate = {
  outcome: "prepared", shopId: "shop-1", senderWabaId: "waba-1",
  purpose: "INITIAL_NO_OFFER", canonicalLanguageTag: "en-GB", selectionSource: "merchant-fallback",
  variantId: "variant-1", registrationId: "registration-1", definitionId: "definition-1",
  providerTemplateId: "provider-template-1", providerTemplateName: "approved_initial_no_offer",
  providerLanguageCode: "en_GB", submittedContentHash: "a".repeat(64),
  bindingFingerprint: "b".repeat(64),
  template: { name: "approved_initial_no_offer", language: { code: "en_GB" }, components: [
    { type: "body", parameters: [{ type: "text", text: "Alice" }, { type: "text", text: "2 x Shoes" }] },
    { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "token" }] },
  ] },
};

function fixture() {
  const recovery = {
    id: "recovery-1", shopId: "shop-1", generation: 3, status: "DETECTED",
    checkoutUrl, lineItems: [{ title: "Shoes", variantTitle: "Default Title", quantity: 2 }],
    lastExternalActivityAt: new Date(now.getTime() - 60_000), expiredAt: null,
    customer: { firstName: "Alice" },
    shop: { id: "shop-1", domain: "shop.test", platform: "SHOPIFY", status: "ACTIVE",
      defaultLanguageTag: "en-GB" },
  };
  const attempt = {
    id: "attempt-1", checkoutRecoveryId: "recovery-1", sequence: 1, trigger: "INITIAL",
    status: "PENDING", sentAt: null, outboundMessageId: null, followUpDueAt: null,
  };
  const database = {
    checkoutRecovery: { findUnique: vi.fn(async () => recovery) },
    recoveryOutreachAttempt: { findFirst: vi.fn(async () => attempt) },
    conversationMessage: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
    },
    checkoutRecoveryStatusHistory: { create: vi.fn(async () => ({ id: "history-1" })) },
  };
  const preparer = { prepare: vi.fn(async () => preparedTemplate) };
  const log = { warn: vi.fn(), error: vi.fn() };
  const lifetimeReader = { read: vi.fn(async () => 21) };
  const service = new InitialNoOfferFallbackService(
    database as never, preparer as never, async () => "waba-1", () => now,
    log as never, lifetimeReader,
  );
  return { service, database, preparer, log, lifetimeReader, recovery, attempt };
}

beforeEach(() => vi.clearAllMocks());

describe("InitialNoOfferFallbackService", () => {
  it.each<InitialFallbackTrigger>([
    "MERCHANT_MODE_NONE", "NO_VERIFIED_PROMOTION", "AI_UNAVAILABLE", "MCP_UNAVAILABLE",
    "DISCOUNT_REVALIDATION_UNAVAILABLE", "DISCOUNT_INVALID_OR_INCOMPATIBLE",
    "PRICE_UNVERIFIABLE", "ALTERNATIVE_PRODUCT_UNVERIFIABLE", "IMAGE_UNAVAILABLE",
  ])("prepares the same approved neutral TEXT path for trigger %s", async (trigger) => {
    const f = fixture();
    const result = await f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      outreachAttemptId: "attempt-1", trigger });

    expect(result).toMatchObject({ kind: "PREPARED", trigger, prepared: preparedTemplate,
      send: { recoveryPromise: { kind: "NO_OFFER" }, dynamicUrlButton: { index: 0, text: "token" } } });
    expect(f.preparer.prepare).toHaveBeenCalledWith(expect.objectContaining({
      shopId: "shop-1", senderWabaId: "waba-1", stage: "INITIAL",
      promotionTarget: "CHECKOUT", offerPresentation: "NO_OFFER",
      merchantLanguageTag: "en-GB", customerFirstName: "Alice",
      shopName: { shopId: "shop-1", value: "shop.test" },
      checkout: expect.objectContaining({ shopId: "shop-1", url: checkoutUrl }),
      checkoutItems: { shopId: "shop-1", lineItems: f.recovery.lineItems },
    }));
    expect(f.preparer.prepare.mock.calls[0]?.[0]).not.toHaveProperty("verifiedOffer");
    expect(f.preparer.prepare.mock.calls[0]?.[0]).not.toHaveProperty("promotionalProduct");
    expect(f.preparer.prepare.mock.calls[0]?.[0]).not.toHaveProperty("productImage");
  });

  it("blocks an empty or malformed saved basket before template preparation", async () => {
    const f = fixture();
    f.recovery.lineItems = [];
    await expect(f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      outreachAttemptId: "attempt-1", trigger: "AI_UNAVAILABLE" }))
      .resolves.toEqual({ kind: "BLOCKED", reason: "CHECKOUT_ITEMS_UNAVAILABLE" });
    expect(f.preparer.prepare).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong shop", { shopId: "other-shop" }, "INELIGIBLE_RECOVERY"],
    ["terminal recovery", { status: "COMPLETED" }, "INELIGIBLE_RECOVERY"],
  ] as const)("blocks %s without preparing a template", async (_label, recoveryPatch, reason) => {
    const f = fixture();
    Object.assign(f.recovery, recoveryPatch);
    await expect(f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      outreachAttemptId: "attempt-1", trigger: "MCP_UNAVAILABLE" }))
      .resolves.toEqual({ kind: "BLOCKED", reason });
    expect(f.preparer.prepare).not.toHaveBeenCalled();
  });

  it("blocks a cross-recovery or non-sequence-one attempt", async () => {
    const f = fixture();
    f.database.recoveryOutreachAttempt.findFirst.mockResolvedValueOnce({
      ...f.attempt, checkoutRecoveryId: "other-recovery", sequence: 2,
    } as never);
    await expect(f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      outreachAttemptId: "attempt-1", trigger: "PRICE_UNVERIFIABLE" }))
      .resolves.toEqual({ kind: "BLOCKED", reason: "INVALID_ATTEMPT" });
    expect(f.preparer.prepare).not.toHaveBeenCalled();
  });

  it("reconciles an existing durable provider dispatch instead of preparing a duplicate", async () => {
    const f = fixture();
    f.database.conversationMessage.findFirst.mockResolvedValueOnce({ id: "pending-message" } as never);
    await expect(f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      outreachAttemptId: "attempt-1", trigger: "AI_UNAVAILABLE" }))
      .resolves.toEqual({ kind: "RETRY", reason: "PROVIDER_OUTCOME_UNCERTAIN" });
    expect(f.database.conversationMessage.findFirst).toHaveBeenCalledWith({
      where: { providerDispatchKey: "recovery-outreach:attempt-1" }, select: { id: true },
    });
    expect(f.preparer.prepare).not.toHaveBeenCalled();
  });

  it("blocks when the independently approved no-offer template is unavailable", async () => {
    const f = fixture();
    f.preparer.prepare.mockResolvedValueOnce({ outcome: "unavailable", reason: "NO_APPROVED_ASSIGNMENT",
      purpose: "INITIAL_NO_OFFER" } as never);
    await expect(f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      outreachAttemptId: "attempt-1", trigger: "AI_UNAVAILABLE" }))
      .resolves.toEqual({ kind: "BLOCKED", reason: "TEMPLATE_UNAPPROVED" });
    expect(f.database.checkoutRecoveryStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        checkoutRecoveryId: "recovery-1", fromStatus: "DETECTED", toStatus: "DETECTED",
        reason: "CONFIGURATION_BLOCKED", source: "INITIAL_NO_OFFER_FALLBACK",
        metadata: { outreachAttemptId: "attempt-1", fallbackReason: "NO_APPROVED_ASSIGNMENT" },
      }),
    });
  });

  it("returns a retry and logs the original required-state error", async () => {
    const f = fixture();
    const failure = new Error("database failure");
    f.database.checkoutRecovery.findUnique.mockRejectedValueOnce(failure);
    await expect(f.service.prepare({ shopId: "shop-1", recoveryId: "recovery-1",
      outreachAttemptId: "attempt-1", trigger: "MCP_UNAVAILABLE" }))
      .resolves.toEqual({ kind: "RETRY", reason: "REQUIRED_STATE_UNAVAILABLE" });
    expect(f.log.error).toHaveBeenCalledWith("recovery_template.initial_fallback.failed",
      expect.objectContaining({ error: failure, reason: "REQUIRED_STATE_UNAVAILABLE" }));
  });
});