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
        updateMany: vi.fn(),
        upsert: vi.fn(),
        update: vi.fn(),
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
      getOrCreateRecoveryConversation: vi.fn(async () => ({
        id: "conversation-1",
      })),
      getAgentSnapshot: vi.fn(async () => ({
        conversationId: "clarification-1",
        shop: "shop.myshopify.com",
        type: "PRODUCT_SUPPORT",
        summary: null,
        version: 3,
        languageTag: "en-GB",
        languageSource: "shopify",
        messages: [
          { role: "user", content: "Which basket?" },
          { role: "user", content: "The blue one" },
        ],
      })),
    },
    conversationMessageServiceMock: {
      buildRecoveryMessage: vi.fn(() => "Hello!"),
      createPendingRecoveryMessage: vi.fn(async () => ({ id: "message-1" })),
      markMessageSent: vi.fn(async () => ({})),
    },
    whatsAppServiceMock: {
      sendWhatsAppText: vi.fn(async () => ({ providerMessageId: "wamid-1" })),
      sendWhatsAppTemplate: vi.fn(async () => ({
        providerMessageId: "wamid-1",
      })),
      getProviderAccountId: vi.fn(() => "provider-account-1"),
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
    pendingCandidateServiceMock: {
      refreshCandidateActivity: vi.fn(),
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
      handleProviderFailure: vi.fn(async () => undefined),
      releaseBeforeProvider: vi.fn(async () => undefined),
    },
  };
});

const { prismaMock } = hoisted;
const { lookupServiceMock } = hoisted;

vi.mock("../../../src/lib/db.js", () => ({
  default: hoisted.prismaMock,
}));

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
vi.mock("../../../src/services/whatsapp-template-selector.service.js", () => ({
  whatsappTemplateSelectorService: hoisted.whatsappTemplateSelectorMock,
}));
vi.mock("../../../src/services/pending-recovery-candidate.service.js", () => ({
  pendingRecoveryCandidateService: hoisted.pendingCandidateServiceMock,
}));
vi.mock("../../../src/services/recovery-billing.service.js", () => ({
  recoveryBillingService: hoisted.recoveryBillingServiceMock,
}));
vi.mock("../../../src/services/outbound-whatsapp-admission.service.js", () => ({
  outboundWhatsAppAdmissionService: {
    getProviderAccountId: vi.fn(() => "provider-account-1"),
  },
}));

import { CheckoutRecoveryService } from "../../../src/services/checkout-recovery.service.js";

const service = new CheckoutRecoveryService();

const event = {
  shopDomain: "shop.myshopify.com",
  checkoutToken: "checkout_1",
};

const activeRecovery = {
  id: "recovery-1",
  status: "ENGAGED",
  cartToken: "cart_1",
  checkoutUrl: "https://shop.myshopify.com/recover?key=abc",
  detectedAt: new Date("2026-08-28T12:00:00Z"),
};

const currentCheckout = {
  shopifyAbandonedCheckoutId: "gid://shopify/AbandonedCheckout/1",
  abandonedCheckoutUrl: "https://shop.myshopify.com/recover?key=abc",
  createdAt: "2026-08-28T12:00:00Z",
  completedAt: null,
  currencyCode: "USD",
  totalPrice: "59.99",
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
      quantity: 3,
      price: "20.00",
    },
  ],
};

describe("CheckoutRecoveryService.handleCheckoutUpdatedContract (ARCH-001-BACKGROUND-006)", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop_1", status: "ACTIVE" });
    prismaMock.checkoutRecovery.findUnique.mockResolvedValue(activeRecovery);
    prismaMock.checkoutRecovery.updateMany.mockResolvedValue({ count: 1 });
    lookupServiceMock.lookup.mockResolvedValue({
      kind: "found",
      checkout: currentCheckout,
    });
    hoisted.pendingCandidateServiceMock.refreshCandidateActivity.mockResolvedValue(
      {
        outcome: "not-found",
      },
    );
  });

  it("discards the update and does not call Shopify when no recovery exists", async () => {
    prismaMock.checkoutRecovery.findUnique.mockResolvedValue(null);

    const result = await service.handleCheckoutUpdatedContract(event);

    expect(result).toEqual({ kind: "discarded", reason: "recovery-not-found" });
    // No Shopify lookup, no write.
    expect(lookupServiceMock.lookup).not.toHaveBeenCalled();
    expect(prismaMock.checkoutRecovery.updateMany).not.toHaveBeenCalled();
  });

  it("refreshes an existing active recovery from current Shopify data", async () => {
    const result = await service.handleCheckoutUpdatedContract(event);

    expect(result).toEqual({
      kind: "refreshed",
      recoveryId: "recovery-1",
      status: "ENGAGED",
    });

    // Lookup called once with durable recovery-derived inputs.
    expect(lookupServiceMock.lookup).toHaveBeenCalledTimes(1);
    const input = lookupServiceMock.lookup.mock.calls[0][0];
    expect(input.checkoutToken).toBe("checkout_1");
    expect(input.cartToken).toBe("cart_1");
    expect(input.abandonedCheckoutUrl).toBe(activeRecovery.checkoutUrl);
    expect(input.checkoutCreatedAt).toBe("2026-08-28T12:00:00.000Z");

    // Only basket/content fields are refreshed; lifecycle is preserved.
    expect(prismaMock.checkoutRecovery.updateMany).toHaveBeenCalledWith({
      where: {
        id: "recovery-1",
        status: { in: ["DETECTED", "MESSAGE_SENT", "ENGAGED"] },
      },
      data: {
        currency: "USD",
        totalPrice: "59.99",
        checkoutUrl: currentCheckout.abandonedCheckoutUrl,
        lineItems: [
          {
            productId: "gid://shopify/Product/1",
            variantId: "gid://shopify/ProductVariant/1",
            title: "Teal Dress",
            variantTitle: "M",
            sku: "SKU-1",
            quantity: 3,
            price: "20.00",
          },
        ],
      },
    });
  });

  it("stops an inactive checkout update before candidate refresh or Shopify work", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop_1", status: "UNINSTALLED" });

    const result = await service.handleCheckoutUpdatedContract(event);

    expect(result).toEqual({ kind: "ignored", reason: "shop-unavailable" });
    expect(hoisted.pendingCandidateServiceMock.refreshCandidateActivity).not.toHaveBeenCalled();
    expect(prismaMock.checkoutRecovery.findUnique).not.toHaveBeenCalled();
    expect(lookupServiceMock.lookup).not.toHaveBeenCalled();
    expect(prismaMock.checkoutRecovery.updateMany).not.toHaveBeenCalled();
  });

  it("reschedules a matching pending candidate before checking durable recovery", async () => {
    hoisted.pendingCandidateServiceMock.refreshCandidateActivity.mockResolvedValue(
      {
        outcome: "rescheduled",
        jobId: "candidate-1",
      },
    );

    const result = await service.handleCheckoutUpdatedContract({
      ...event,
      activityAt: "2026-08-28T00:02:00.000Z",
    });

    expect(result).toEqual({
      kind: "pending",
      outcome: "rescheduled",
      jobId: "candidate-1",
    });
    expect(lookupServiceMock.lookup).not.toHaveBeenCalled();
    expect(
      hoisted.pendingCandidateServiceMock.refreshCandidateActivity,
    ).toHaveBeenCalledWith({
      shopId: "shop_1",
      checkoutToken: "checkout_1",
      cartToken: null,
      activityAt: "2026-08-28T00:02:00.000Z",
      isEmpty: null,
    });
  });

  it("handles cart activity without a Shopify lookup or candidate creation", async () => {
    hoisted.pendingCandidateServiceMock.refreshCandidateActivity.mockResolvedValue(
      {
        outcome: "cancelled",
        jobId: "candidate-1",
      },
    );

    const result = await service.handleCartActivityContract({
      shopId: "shop_1",
      shopDomain: "shop.myshopify.com",
      cartToken: "cart_1",
      isEmpty: true,
      activityAt: "2026-08-28T00:04:00.000Z",
    });

    expect(result).toEqual({
      kind: "pending",
      outcome: "cancelled",
      jobId: "candidate-1",
    });
    expect(
      hoisted.pendingCandidateServiceMock.refreshCandidateActivity,
    ).toHaveBeenCalledWith({
      shopId: "shop_1",
      checkoutToken: null,
      cartToken: "cart_1",
      activityAt: "2026-08-28T00:04:00.000Z",
      isEmpty: true,
    });
    expect(lookupServiceMock.lookup).not.toHaveBeenCalled();
    expect(prismaMock.checkoutRecovery.upsert).not.toHaveBeenCalled();
  });

  it("stops inactive cart activity before refreshing a pending candidate", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop_1", status: "UNINSTALLED" });

    const result = await service.handleCartActivityContract({
      shopId: "shop_1",
      shopDomain: "shop.myshopify.com",
      cartToken: "cart_1",
      isEmpty: false,
      activityAt: "2026-08-28T00:04:00.000Z",
    });

    expect(result).toEqual({ kind: "ignored", reason: "shop-unavailable" });
    expect(hoisted.pendingCandidateServiceMock.refreshCandidateActivity).not.toHaveBeenCalled();
  });

  it("does not use webhook basket data (only the Shopify lookup result)", async () => {
    // The v2 checkout-updated contract carries only shopDomain + checkoutToken,
    // so there is no basket in the event to abuse. The refresh still uses only
    // current Shopify data for content fields.
    const result = await service.handleCheckoutUpdatedContract(event);

    expect(result.kind).toBe("refreshed");
    const args = prismaMock.checkoutRecovery.updateMany.mock.calls[0][0];
    expect(args.data.currency).toBe("USD");
    expect(args.data.totalPrice).toBe("59.99");
    expect(args.data.lineItems[0].title).toBe("Teal Dress");
    // Lifecycle fields must not be touched by a refresh.
    expect(args.data.status).toBeUndefined();
    expect(args.data.detectedAt).toBeUndefined();
    expect(args.data.messageSentAt).toBeUndefined();
    expect(args.data.engagedAt).toBeUndefined();
    expect(args.data.completedAt).toBeUndefined();
  });

  it("does not restart recovery timing or create a new recovery on refresh", async () => {
    await service.handleCheckoutUpdatedContract(event);

    // No upsert/create of a recovery, and no message workflow triggered.
    expect(prismaMock.checkoutRecovery.upsert).not.toHaveBeenCalled();
    expect(hoisted.whatsAppServiceMock.sendWhatsAppText).not.toHaveBeenCalled();
    const args = prismaMock.checkoutRecovery.updateMany.mock.calls[0][0];
    expect(args.data.status).toBeUndefined();
    expect(args.data.detectedAt).toBeUndefined();
  });

  it("does not reopen a terminal recovery (no Shopify lookup, no write)", async () => {
    prismaMock.checkoutRecovery.findUnique.mockResolvedValue({
      ...activeRecovery,
      status: "COMPLETED",
    });

    const result = await service.handleCheckoutUpdatedContract(event);

    expect(result).toEqual({
      kind: "ignored",
      reason: "terminal-completed",
    });
    expect(lookupServiceMock.lookup).not.toHaveBeenCalled();
    expect(prismaMock.checkoutRecovery.updateMany).not.toHaveBeenCalled();
  });

  it("is idempotent: a duplicate/stale update with an already-transitioned recovery is ignored", async () => {
    // A concurrent order completion transitioned the recovery to terminal, so
    // the status-guarded updateMany matches nothing.
    prismaMock.checkoutRecovery.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.handleCheckoutUpdatedContract(event);

    expect(result).toEqual({ kind: "ignored", reason: "already-transitioned" });
  });

  it("leaves a transient provider failure retryable (throws, not discarded)", async () => {
    lookupServiceMock.lookup.mockResolvedValue({
      kind: "provider-error",
      message: "boom",
    });

    await expect(service.handleCheckoutUpdatedContract(event)).rejects.toThrow(
      /provider error/,
    );
    // No write was attempted.
    expect(prismaMock.checkoutRecovery.updateMany).not.toHaveBeenCalled();
  });

  it("discards when the current checkout cannot be identified deterministically", async () => {
    lookupServiceMock.lookup.mockResolvedValue({
      kind: "ambiguous",
      matched: 2,
    });

    const result = await service.handleCheckoutUpdatedContract(event);

    expect(result).toEqual({ kind: "discarded", reason: "lookup-ambiguous" });
    expect(prismaMock.checkoutRecovery.updateMany).not.toHaveBeenCalled();
  });
});

describe("CheckoutRecoveryService clarification context", () => {
  it("combines a current recovery with standalone settled fragments", async () => {
    prismaMock.checkoutRecovery.findUnique.mockResolvedValue({
      id: "recovery-current",
      shop: { domain: "shop.myshopify.com" },
      status: "ENGAGED",
      checkoutToken: "checkout-current",
      completedAt: null,
      totalPrice: "42.00",
      customer: {
        id: "customer-1",
        phone: "+15551234567",
        firstName: "Ada",
      },
    } as any);

    const context = await service.getAgentContextForStandaloneConversation({
      checkoutRecoveryId: "recovery-current",
      conversationId: "clarification-1",
      pendingTurnStartedAt: new Date("2026-09-08T12:00:00Z"),
    });

    expect(context.recovery.id).toBe("recovery-current");
    expect(context.shop).toBe("shop.myshopify.com");
    expect(context.customer).toEqual({
      id: "customer-1",
      phone: "+15551234567",
      firstName: "Ada",
    });
    expect(context.conversation).toMatchObject({
      conversationId: "clarification-1",
      type: "PRODUCT_SUPPORT",
      messages: [
        { role: "user", content: "Which basket?" },
        { role: "user", content: "The blue one" },
      ],
    });
  });
});

describe("CheckoutRecoveryService.getAgentContext turn ordering", () => {
  it("orders equal-timestamp recovery fragments by descending id before reversing", async () => {
    prismaMock.checkoutRecovery.findUnique.mockResolvedValue({
      id: "recovery-1",
      shop: { domain: "shop.myshopify.com" },
      status: "ENGAGED",
      checkoutToken: "checkout-1",
      completedAt: null,
      totalPrice: "42.00",
      customer: { id: "customer-1", phone: "+15551234567", firstName: "Ada" },
      conversation: {
        id: "conversation-1",
        type: "RECOVERY",
        summary: null,
        inboundVersion: 2,
        languageTag: null,
        languageSource: null,
        messages: [
          { id: "message-2", direction: "INBOUND", content: "second" },
          { id: "message-1", direction: "INBOUND", content: "first" },
        ],
      },
    } as any);

    const context = await service.getAgentContext({
      checkoutRecoveryId: "recovery-1",
      conversationId: "conversation-1",
      pendingTurnStartedAt: new Date("2026-09-08T12:00:00.000Z"),
    });

    expect(context.conversation.messages).toEqual([
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ]);
    expect(prismaMock.checkoutRecovery.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          conversation: expect.objectContaining({
            select: expect.objectContaining({
              messages: expect.objectContaining({
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              }),
            }),
          }),
        }),
      }),
    );
  });
});
