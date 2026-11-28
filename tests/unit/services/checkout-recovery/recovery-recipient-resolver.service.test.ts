import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  shop: { findUnique: vi.fn() },
  recoveryCustomer: { resolve: vi.fn() },
  stored: vi.fn(),
}));
vi.mock("../../../../src/lib/db.js", () => ({ default: { shop: mocks.shop } }));
vi.mock(
  "../../../../src/services/checkout-recovery/recovery-shopify-customer.service.js",
  () => ({
    recoveryShopifyCustomerService: mocks.recoveryCustomer,
  }),
);
vi.mock(
  "../../../../src/services/shopify-whatsapp-consent/phone-resolution.js",
  () => ({
    selectStoredShopifyCustomerPhone: mocks.stored,
  }),
);
import { RecoveryRecipientResolverService } from "../../../../src/services/checkout-recovery/recovery-recipient-resolver.service.js";

describe("RecoveryRecipientResolverService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shop.findUnique.mockResolvedValue({ id: "shop-a" });
    mocks.recoveryCustomer.resolve.mockResolvedValue({ id: "guest-a" });
  });

  it("selects the stored evidence-backed phone for the resolved Moda customer", async () => {
    mocks.stored.mockResolvedValue({
      customerId: "guest-a",
      customerPhoneId: "phone-a",
      recipient: "447400123456",
      source: "billing",
    });
    await expect(
      new RecoveryRecipientResolverService().resolve({
        shop: "shop-a",
      } as never),
    ).resolves.toBe("447400123456");
    expect(mocks.stored).toHaveBeenCalledWith({
      customerId: "guest-a",
      shopId: "shop-a",
    });
  });

  it("returns null when no phone has current evidence-backed consent", async () => {
    mocks.stored.mockResolvedValue(null);
    await expect(
      new RecoveryRecipientResolverService().resolveForCustomerInShop(
        "guest-a",
        "shop-a",
      ),
    ).resolves.toBeNull();
  });

  it.each([
    "123456789012345678901234567890123456",
    "0123456789",
    "1",
    "44abc7400123456",
    "+447400123456",
    "44 7400 123456",
    "",
  ])(
    "rejects noncanonical stored recipient %s at both entrypoints",
    async (recipient) => {
      mocks.stored.mockResolvedValue({ recipient });
      const resolver = new RecoveryRecipientResolverService();
      await expect(
        resolver.resolveForCustomerInShop("guest-a", "shop-a"),
      ).resolves.toBeNull();
      await expect(
        resolver.resolve({ shop: "shop-a" } as never),
      ).resolves.toBeNull();
    },
  );
});
