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
      createPendingRecoveryMessage: vi.fn(async () => ({ id: "message-1" })),
      markMessageSent: vi.fn(async () => ({})),
    },
    whatsAppServiceMock: {
      sendWhatsAppText: vi.fn(async () => ({ providerMessageId: "wamid-1" })),
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

import { CheckoutRecoveryService } from "../../../src/services/checkout-recovery.service.js";

const service = new CheckoutRecoveryService();

const candidate = {
  shopId: "shop_1",
  checkoutToken: "checkout_1",
  cartToken: "cart_1",
  abandonedCheckoutUrl: "https://shop.myshopify.com/recover?key=abc",
  checkoutCreatedAt: "2026-08-28T12:00:00Z",
};

const recoverableCheckout = {
  shopifyAbandonedCheckoutId: "gid://shopify/AbandonedCheckout/1",
  abandonedCheckoutUrl: "https://shop.myshopify.com/recover?key=abc",
  createdAt: "2026-08-28T12:00:00Z",
  completedAt: null,
  currencyCode: "USD",
  totalPrice: "49.99",
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
    redisMock.set.mockResolvedValue("OK");
    redisMock.get.mockResolvedValue(null);
    redisMock.del.mockResolvedValue(1);
    // Default: shop exists, no existing recovery, recoverable lookup result.
    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop_1" });
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
    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop_1" });
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

    // The recovery-message workflow should run for a newly materialized recovery.
    expect(whatsAppServiceMock.sendWhatsAppText).toHaveBeenCalledTimes(1);
  });

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

