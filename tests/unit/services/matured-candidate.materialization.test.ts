import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  return {
    redisMock: {
      set: vi.fn(async () => "OK"),
      get: vi.fn(async () => null),
      del: vi.fn(async () => 1),
    },
    prismaMock: {
      shop: {
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn(),
      },
      checkoutRecovery: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
        update: vi.fn(),
      },
      conversation: {
        upsert: vi.fn(),
      },
      conversationMessage: {
        create: vi.fn(),
        update: vi.fn(),
      },
    },
    lookupServiceMock: {
      resolveShopDomain: vi.fn(async () => "shop.myshopify.com"),
      lookup: vi.fn(),
    },
    customerServiceMock: {
      resolveCustomer: vi.fn(async () => null),
    },
    conversationServiceMock: {
      getOrCreateRecoveryConversation: vi.fn(async (recoveryId: string) => ({
        id: `conversation-${recoveryId}`,
      })),
    },
    conversationMessageServiceMock: {
      buildRecoveryMessage: vi.fn(() => "Hello!"),
      buildRecoveryTemplateDescriptor: vi.fn(
        ({ purpose, templateName, canonicalLanguageTag, providerLanguageCode }) =>
          `[WhatsApp template sent; purpose=${purpose}; template=${templateName}; canonicalLanguage=${canonicalLanguageTag}; providerLanguage=${providerLanguageCode}]`,
      ),
      createPendingRecoveryMessage: vi.fn(async () => ({ id: "message-1" })),
      markMessageSent: vi.fn(async () => ({})),
    },
    whatsAppServiceMock: {
      sendWhatsAppText: vi.fn(async () => ({ providerMessageId: "wamid-1" })),
      sendWhatsAppTemplate: vi.fn(async () => ({ providerMessageId: "wamid-1" })),
      getProviderAccountId: vi.fn(() => "provider-account-1"),
    },
    outboundWhatsAppAdmissionServiceMock: {
      getProviderAccountId: vi.fn(() => "provider-account-1"),
      sendTemplate: vi.fn(async (input: { conversationId: string; content: string; to: string; templateName: string; languageCode: string }) => {
        const message = await hoisted.conversationMessageServiceMock.createPendingRecoveryMessage(
          input.conversationId,
          input.content,
        );
        try {
          const result = await hoisted.whatsAppServiceMock.sendWhatsAppTemplate({
            to: input.to,
            templateName: input.templateName,
            languageCode: input.languageCode,
          });
          await hoisted.conversationMessageServiceMock.markMessageSent(
            message.id,
            result.providerMessageId,
          );
          return {
            kind: "admitted" as const,
            messageId: message.id,
            conversationId: input.conversationId,
            terminal: false,
          };
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code !== "invalid-provider-response") {
            await hoisted.prismaMock.conversationMessage.update({
              where: { id: message.id },
              data: { status: "FAILED" },
            });
          }
          throw error;
        }
      }),
    },
    whatsappTemplateSelectorMock: {
      select: vi.fn(async () => ({
        outcome: "selected",
        canonicalLanguageTag: "en-GB",
        providerLanguageCode: "en_GB",
        providerTemplateName: "checkout_recovery",
        providerTemplateId: null,
        selectionSource: "exact",
        marketCapability: "supported",
      })),
    },
    recoveryBillingServiceMock: {
      admit: vi.fn(async () => ({
        kind: "admitted",
        admission: {
          kind: "paid",
          sourceKey: "recovery:shop_1:recovery-1",
          policy: { shopId: "shop_1" },
        },
      })),
      commitSuccessfulInitiation: vi.fn(async () => undefined),
      handleProviderFailure: vi.fn(async () => "definitive" as const),
      releaseBeforeProvider: vi.fn(async () => undefined),
    },
  };
});

const { redisMock } = hoisted;
const { prismaMock } = hoisted;
const { lookupServiceMock } = hoisted;
const { customerServiceMock } = hoisted;
const { conversationServiceMock } = hoisted;
const { conversationMessageServiceMock } = hoisted;
const { whatsAppServiceMock } = hoisted;
const { outboundWhatsAppAdmissionServiceMock } = hoisted;
const { whatsappTemplateSelectorMock } = hoisted;
const { recoveryBillingServiceMock } = hoisted;

vi.mock("../../../src/lib/db.js", () => ({
  default: hoisted.prismaMock,
}));

// Checkout-scoped Redis lock/tombstone (ARCH-001-BACKGROUND-005).
vi.mock("../../../src/lib/redis.js", () => ({
  connectionRedis: hoisted.redisMock,
}));

// Shopify lookup owned by ARCH-001-BACKGROUND-003.
vi.mock("../../../src/services/abandoned-checkout-lookup.service.js", () => ({
  abandonedCheckoutLookupService: hoisted.lookupServiceMock,
}));

vi.mock("../../../src/services/customer.service.js", () => ({
  customerService: hoisted.customerServiceMock,
}));
vi.mock("../../../src/services/conversation.service.js", () => ({
  conversationService: hoisted.conversationServiceMock,
}));
vi.mock("../../../src/services/conversation.message.service.js", () => ({
  conversationMessageService: hoisted.conversationMessageServiceMock,
}));
vi.mock("../../../src/services/whatsapp.service.js", () => ({
  whatsAppService: hoisted.whatsAppServiceMock,
}));
vi.mock("../../../src/services/outbound-whatsapp-admission.service.js", () => ({
  outboundWhatsAppAdmissionService: hoisted.outboundWhatsAppAdmissionServiceMock,
}));
vi.mock("../../../src/services/whatsapp-template-selector.service.js", () => ({
  whatsappTemplateSelectorService: hoisted.whatsappTemplateSelectorMock,
}));
vi.mock("../../../src/services/recovery-billing.service.js", () => ({
  recoveryBillingService: hoisted.recoveryBillingServiceMock,
}));

import { CheckoutRecoveryService } from "../../../src/services/checkout-recovery.service.js";

const service = new CheckoutRecoveryService();

const candidate = {
  shopId: "shop_1",
  shopDomain: "shop.myshopify.com",
  checkoutToken: "checkout_1",
  cartToken: "cart_1",
  abandonedCheckoutUrl: "https://shop.myshopify.com/recover?key=abc",
  checkoutCreatedAt: "2026-08-28T12:00:00Z",
  internationalContext: {
    languageTag: "fr-CA",
    languageSource: "shopify" as const,
    countryCode: "CA",
    currencyCode: "USD",
    timeZone: "America/Toronto",
  },
};

const recoverableCheckout = {
  shopifyAbandonedCheckoutId: "gid://shopify/AbandonedCheckout/1",
  abandonedCheckoutUrl: "https://shop.myshopify.com/recover?key=abc",
  createdAt: "2026-08-28T12:00:00Z",
  completedAt: null,
  currencyCode: "USD",
  totalPrice: "49.99",
  internationalContext: {
    languageTag: "en-GB",
    languageSource: null,
    countryCode: "GB",
    currencyCode: "GBP",
    timeZone: "Europe/London",
  },
  customer: {
    shopifyCustomerId: "gid://shopify/Customer/1",
    email: "buyer@example.com",
    phone: "+15551234567",
    firstName: "Ada",
    lastName: "Lovelace",
  },
  lineItems: [
    {
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/1",
      title: "Teal Dress",
      variantTitle: "M",
      sku: "SKU-1",
      quantity: 2,
      price: "20.00",
    },
  ],
};

describe("CheckoutRecoveryService.materializeMaturedCandidate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    whatsappTemplateSelectorMock.select.mockResolvedValue({
      outcome: "selected",
      canonicalLanguageTag: "en-GB",
      providerLanguageCode: "en_GB",
      providerTemplateName: "checkout_recovery",
      providerTemplateId: null,
      selectionSource: "exact",
      marketCapability: "supported",
    });
    whatsAppServiceMock.sendWhatsAppTemplate.mockResolvedValue({
      providerMessageId: "wamid-1",
    });
    redisMock.set.mockResolvedValue("OK");
    redisMock.get.mockResolvedValue(null);
    redisMock.del.mockResolvedValue(1);
    // Default: shop exists, no existing recovery, recoverable lookup result.
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop_1",
      status: "ACTIVE",
      settings: {
        defaultLanguageTag: "pt-BR",
        defaultCountryCode: "BR",
        defaultTimeZone: "America/Sao_Paulo",
      },
    });
    prismaMock.shop.findUniqueOrThrow.mockResolvedValue({ id: "shop_1" });
    prismaMock.checkoutRecovery.findUnique.mockResolvedValue(null);
    lookupServiceMock.lookup.mockResolvedValue({
      kind: "found",
      checkout: recoverableCheckout,
    });
    prismaMock.checkoutRecovery.upsert.mockImplementation(async ({ create }) => ({
      id: "recovery-1",
      status: "DETECTED",
      ...create,
    }));
  });

  it("creates a recovery from current Shopify data when the lookup is found and recoverable", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop_1", status: "ACTIVE" });
    prismaMock.checkoutRecovery.findUnique.mockResolvedValue(null);

    const result = await service.materializeMaturedCandidate(candidate);

    expect(result.outcome).toBe("recovery-created");

    // Recovery must be upserted with current Shopify data, not webhook basket.
    expect(prismaMock.checkoutRecovery.upsert).toHaveBeenCalled();
    const call = prismaMock.checkoutRecovery.upsert.mock.calls[0][0];
    expect(call.create.currency).toBe("USD");
    expect(call.create.totalPrice).toBe("49.99");
    expect(call.create.localTotal).toBeUndefined();
    expect(call.create.checkoutUrl).toBe(recoverableCheckout.abandonedCheckoutUrl);
    expect(call.create.lineItems[0].title).toBe("Teal Dress");
    expect(call.create.lineItems[0].quantity).toBe(2);

    expect(
      conversationServiceMock.getOrCreateRecoveryConversation,
    ).toHaveBeenCalledWith("recovery-1", {
      languageTag: "fr-CA",
      languageSource: "shopify",
      countryCode: "GB",
      currencyCode: "GBP",
      timeZone: "Europe/London",
    });

    // The recovery-message workflow should run for a newly materialized recovery.
    expect(whatsAppServiceMock.sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
  });

  it("discards an inactive matured candidate before resolving Shopify data", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop_1", status: "UNINSTALLED" });

    const result = await service.materializeMaturedCandidate(candidate);

    expect(result).toEqual({
      outcome: "discarded-shop-unavailable",
      checkoutToken: "checkout_1",
    });
    expect(lookupServiceMock.resolveShopDomain).not.toHaveBeenCalled();
    expect(lookupServiceMock.lookup).not.toHaveBeenCalled();
    expect(prismaMock.checkoutRecovery.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.checkoutRecovery.upsert).not.toHaveBeenCalled();
    expect(conversationServiceMock.getOrCreateRecoveryConversation).not.toHaveBeenCalled();
    expect(recoveryBillingServiceMock.admit).not.toHaveBeenCalled();
    expect(whatsAppServiceMock.sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("allows provider-check-required templates to reach the provider", async () => {
    whatsappTemplateSelectorMock.select.mockResolvedValue({
      outcome: "provider-check-required",
      canonicalLanguageTag: "fr-CA",
      providerLanguageCode: "fr_CA_CUSTOM",
      providerTemplateName: "checkout_recovery_fr_ca",
      providerTemplateId: null,
      selectionSource: "exact",
      marketCapability: "provider-check-required",
    });

    await service.materializeMaturedCandidate(candidate);

    expect(whatsAppServiceMock.sendWhatsAppTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: "checkout_recovery_fr_ca",
        languageCode: "fr_CA_CUSTOM",
      }),
    );
  });

  it("blocks an exhausted billing admission before creating a conversation or sending", async () => {
    recoveryBillingServiceMock.admit.mockResolvedValueOnce({
      kind: "blocked",
      reason: "allowance-exhausted",
    });

    const result = await service.materializeMaturedCandidate(candidate);

    expect(result.outcome).toBe("recovery-created");
    expect(conversationServiceMock.getOrCreateRecoveryConversation).not.toHaveBeenCalled();
    expect(conversationMessageServiceMock.createPendingRecoveryMessage).not.toHaveBeenCalled();
    expect(whatsAppServiceMock.sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("persists a truthful descriptor for a selected non-English template", async () => {
    whatsappTemplateSelectorMock.select.mockResolvedValue({
      outcome: "selected",
      canonicalLanguageTag: "fr-CA",
      providerLanguageCode: "fr_CA_CUSTOM",
      providerTemplateName: "checkout_recovery_fr_ca",
      providerTemplateId: null,
      selectionSource: "exact",
      marketCapability: "supported",
    });

    await service.materializeMaturedCandidate(candidate);

    expect(conversationMessageServiceMock.buildRecoveryMessage).not.toHaveBeenCalled();
    expect(
      conversationMessageServiceMock.buildRecoveryTemplateDescriptor,
    ).toHaveBeenCalledWith({
      purpose: "checkout-recovery",
      templateName: "checkout_recovery_fr_ca",
      canonicalLanguageTag: "fr-CA",
      providerLanguageCode: "fr_CA_CUSTOM",
    });
    expect(
      conversationMessageServiceMock.createPendingRecoveryMessage,
    ).toHaveBeenCalledWith(
      "conversation-recovery-1",
      expect.stringContaining(
        "[WhatsApp template sent; purpose=checkout-recovery; template=checkout_recovery_fr_ca; canonicalLanguage=fr-CA; providerLanguage=fr_CA_CUSTOM]",
      ),
    );
    expect(
      conversationMessageServiceMock.createPendingRecoveryMessage.mock.calls[0]?.[1],
    ).not.toContain("Hello!");
  });

  it.each([
    { outcome: "template-unavailable", reason: "no-approved-variant" },
    { outcome: "market-unavailable", reason: "unsupported-market" },
  ] as const)("does not send when selection is bounded as $outcome", async (selection) => {
    whatsappTemplateSelectorMock.select.mockResolvedValue(selection);

    await service.materializeMaturedCandidate(candidate);

    expect(whatsAppServiceMock.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(conversationMessageServiceMock.createPendingRecoveryMessage).not.toHaveBeenCalled();
  });

  it("marks the pending message failed when the provider rejects a template", async () => {
    whatsAppServiceMock.sendWhatsAppTemplate.mockRejectedValue(
      Object.assign(new Error("bounded provider rejection"), {
        name: "WhatsAppServiceError",
        code: "provider-rejected",
      }),
    );

    await expect(service.materializeMaturedCandidate(candidate)).rejects.toThrow(
      "bounded provider rejection",
    );
    expect(prismaMock.conversationMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "FAILED" },
      }),
    );
  });

  it.each(["free", "paid"] as const)(
    "keeps a %s recovery message pending after an ambiguous provider response",
    async (kind) => {
      recoveryBillingServiceMock.admit.mockResolvedValueOnce({
        kind: "admitted",
        admission: {
          kind,
          sourceKey: `recovery:shop_1:${kind}-ambiguous`,
          policy: { shopId: "shop_1" },
        },
      });
      recoveryBillingServiceMock.handleProviderFailure.mockResolvedValueOnce(
        "ambiguous",
      );
      whatsAppServiceMock.sendWhatsAppTemplate.mockRejectedValueOnce(
        Object.assign(new Error("malformed response"), {
          name: "WhatsAppServiceError",
          code: "invalid-provider-response",
        }),
      );

      await expect(service.materializeMaturedCandidate(candidate)).rejects.toThrow(
        "malformed response",
      );

      expect(recoveryBillingServiceMock.handleProviderFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: "invalid-provider-response" }),
        }),
      );
      expect(prismaMock.conversationMessage.update).not.toHaveBeenCalled();
    },
  );

  it("discards and does not create a recovery when the checkout is not found", async () => {
    lookupServiceMock.lookup.mockResolvedValue({ kind: "not-found" });

    const result = await service.materializeMaturedCandidate(candidate);

    expect(result.outcome).toBe("discarded-not-found");
    expect(prismaMock.checkoutRecovery.upsert).not.toHaveBeenCalled();
    expect(whatsAppServiceMock.sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("discards and does not create a recovery for an ambiguous lookup", async () => {
    lookupServiceMock.lookup.mockResolvedValue({ kind: "ambiguous", matched: 2 });

    const result = await service.materializeMaturedCandidate(candidate);

    expect(result.outcome).toBe("discarded-ambiguous");
    expect(prismaMock.checkoutRecovery.upsert).not.toHaveBeenCalled();
    expect(whatsAppServiceMock.sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("discards and does not create a recovery when the bounded limit is exceeded", async () => {
    lookupServiceMock.lookup.mockResolvedValue({
      kind: "bounded-limit-exceeded",
      candidateCount: 99,
    });

    const result = await service.materializeMaturedCandidate(candidate);

    expect(result.outcome).toBe("discarded-bound-exceeded");
    expect(prismaMock.checkoutRecovery.upsert).not.toHaveBeenCalled();
    expect(whatsAppServiceMock.sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("discards a completed checkout as not recoverable (no recovery, no message)", async () => {
    lookupServiceMock.lookup.mockResolvedValue({
      kind: "found",
      checkout: { ...recoverableCheckout, completedAt: "2026-08-28T12:30:00Z" },
    });

    const result = await service.materializeMaturedCandidate(candidate);

    expect(result.outcome).toBe("discarded-not-recoverable");
    expect(prismaMock.checkoutRecovery.upsert).not.toHaveBeenCalled();
    expect(whatsAppServiceMock.sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("does not reopen an existing terminal recovery", async () => {
    prismaMock.checkoutRecovery.findUnique.mockResolvedValue({
      status: "COMPLETED",
    });

    const result = await service.materializeMaturedCandidate(candidate);

    expect(result.outcome).toBe("discarded-terminal");
    expect(prismaMock.checkoutRecovery.upsert).not.toHaveBeenCalled();
    expect(whatsAppServiceMock.sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("does not re-run the message workflow when the recovery already exists and is active", async () => {
    prismaMock.checkoutRecovery.findUnique.mockResolvedValue({
      status: "MESSAGE_SENT",
    });

    const result = await service.materializeMaturedCandidate(candidate);

    expect(result.outcome).toBe("no-op-existing");
    expect(prismaMock.checkoutRecovery.upsert).not.toHaveBeenCalled();
    expect(whatsAppServiceMock.sendWhatsAppText).not.toHaveBeenCalled();
  });

  it("is idempotent: a duplicate candidate execution does not upsert again or re-send", async () => {
    prismaMock.checkoutRecovery.findUnique.mockResolvedValue({
      status: "DETECTED",
    });

    const result = await service.materializeMaturedCandidate(candidate);

    expect(result.outcome).toBe("no-op-existing");
    expect(prismaMock.checkoutRecovery.upsert).not.toHaveBeenCalled();
    expect(whatsAppServiceMock.sendWhatsAppText).not.toHaveBeenCalled();
    expect(recoveryBillingServiceMock.admit).not.toHaveBeenCalled();
    expect(recoveryBillingServiceMock.commitSuccessfulInitiation).not.toHaveBeenCalled();
  });

  it("admits the fifth Free recovery and blocks the next distinct recovery before send", async () => {
    let committed = 4;
    recoveryBillingServiceMock.admit
      .mockResolvedValueOnce({
        kind: "admitted",
        admission: {
          kind: "free",
          sourceKey: "recovery:shop_1:recovery-1",
          policy: { shopId: "shop_1" },
        },
      })
      .mockResolvedValueOnce({ kind: "blocked", reason: "allowance-exhausted" });
    recoveryBillingServiceMock.commitSuccessfulInitiation.mockImplementationOnce(
      async () => {
        committed += 1;
      },
    );

    const fifth = await service.materializeMaturedCandidate({
      ...candidate,
      checkoutToken: "checkout-final-credit",
    });
    const next = await service.materializeMaturedCandidate({
      ...candidate,
      checkoutToken: "checkout-after-exhaustion",
    });

    expect(committed).toBe(5);
    expect(fifth.outcome).toBe("recovery-created");
    expect(next.outcome).toBe("recovery-created");
    expect(recoveryBillingServiceMock.admit).toHaveBeenCalledTimes(2);
    expect(recoveryBillingServiceMock.commitSuccessfulInitiation).toHaveBeenCalledTimes(1);
    expect(whatsAppServiceMock.sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
    expect(prismaMock.checkoutRecovery.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "MESSAGE_SENT" }) }),
    );
    expect(prismaMock.checkoutRecovery.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }),
    );
  });

  it("allows paid recovery beyond included units and does not repeat a duplicate send", async () => {
    prismaMock.checkoutRecovery.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: "MESSAGE_SENT" });

    const first = await service.materializeMaturedCandidate({
      ...candidate,
      checkoutToken: "checkout-paid-overage",
    });
    const duplicate = await service.materializeMaturedCandidate({
      ...candidate,
      checkoutToken: "checkout-paid-overage",
    });

    expect(first.outcome).toBe("recovery-created");
    expect(duplicate.outcome).toBe("no-op-existing");
    expect(recoveryBillingServiceMock.admit).toHaveBeenCalledTimes(1);
    expect(recoveryBillingServiceMock.commitSuccessfulInitiation).toHaveBeenCalledTimes(1);
    expect(whatsAppServiceMock.sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
  });

  it("treats a provider error as not-recoverable-discard by throwing (retryable)", async () => {
    lookupServiceMock.lookup.mockResolvedValue({
      kind: "provider-error",
      message: "boom",
    });

    await expect(
      service.materializeMaturedCandidate(candidate),
    ).rejects.toThrow(/provider error/);
    expect(prismaMock.checkoutRecovery.upsert).not.toHaveBeenCalled();
  });

  it("never uses the candidate's embedded webhook basket data for recovery fields", async () => {
    // Candidate only carries correlation identifiers; even if it had extra
    // basket-shaped fields, they must be ignored in favour of current Shopify data.
    const richCandidate = {
      ...candidate,
      lineItems: [{ title: "Stale webhook basket", quantity: 1 }],
      customer: { email: "old@example.com" },
    } as typeof candidate;

    prismaMock.checkoutRecovery.findUnique.mockResolvedValue(null);

    await service.materializeMaturedCandidate(richCandidate);

    const call = prismaMock.checkoutRecovery.upsert.mock.calls[0][0];
    expect(call.create.lineItems[0].title).toBe("Teal Dress");
    expect(call.create.customerId).toBeUndefined();
  });

  it("uses merchant defaults only when current and event context are absent", async () => {
    lookupServiceMock.lookup.mockResolvedValue({
      kind: "found",
      checkout: {
        ...recoverableCheckout,
        currencyCode: null,
        internationalContext: {
          languageTag: null,
          languageSource: null,
          countryCode: null,
          currencyCode: null,
          timeZone: null,
        },
      },
    });

    const result = await service.materializeMaturedCandidate({
      ...candidate,
      internationalContext: {
        languageTag: null,
        languageSource: null,
        countryCode: null,
        currencyCode: null,
        timeZone: null,
      },
    });

    expect(result.outcome).toBe("recovery-created");
    expect(
      conversationServiceMock.getOrCreateRecoveryConversation,
    ).toHaveBeenCalledWith("recovery-1", {
      languageTag: "pt-BR",
      languageSource: "merchant-default",
      countryCode: "BR",
      currencyCode: null,
      timeZone: "America/Sao_Paulo",
    });
  });

  it("discards without creating a recovery or sending a message when an order already processed the checkout (BACKGROUND-005 race guard)", async () => {
    // An order for this checkout was already processed.
    redisMock.get.mockResolvedValue("1");

    const result = await service.materializeMaturedCandidate(candidate);

    expect(result.outcome).toBe("discarded-order-completed");
    expect(prismaMock.checkoutRecovery.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.checkoutRecovery.upsert).not.toHaveBeenCalled();
    expect(whatsAppServiceMock.sendWhatsAppText).not.toHaveBeenCalled();
  });
});

