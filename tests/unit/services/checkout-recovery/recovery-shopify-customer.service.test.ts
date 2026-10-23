import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/lib/db.js", () => ({ default: {} }));
const { upsert } = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock("../../../../src/services/customer.service.js", () => ({
  customerService: { upsertShopifyCustomer: upsert },
}));
import { RecoveryShopifyCustomerService } from "../../../../src/services/checkout-recovery/recovery-shopify-customer.service.js";

const checkout = {
  shop: "test.myshopify.com", checkoutToken: "checkout-1", customer: {
    shopifyCustomerId: "gid://shopify/Customer/901",
    phone: "+447400123456", email: null, firstName: null, lastName: null,
  },
} as never;

describe("recovery Shopify customer identity", () => {
  beforeEach(() => upsert.mockClear());

  it("uses a verified Shopify identifier for new customers, never a phone match", async () => {
    const findMany = vi.fn(async () => []);
    const service = new RecoveryShopifyCustomerService({ customer: { findMany } } as never);
    upsert.mockResolvedValue({ id: "customer-1" });
    await expect(service.resolve(checkout, "shop-1")).resolves.toMatchObject({ id: "customer-1" });
    expect(findMany).toHaveBeenCalledWith({
      where: { shopId: "shop-1", shopifyCustomerId: { in: ["901", "gid://shopify/Customer/901"] } },
      select: { id: true, shopifyCustomerId: true }, take: 2,
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      shopId: "shop-1", shopifyCustomerId: "901", phone: "+447400123456",
    }));
  });

  it("preserves a STOP on the same canonical number despite Shopify formatting changes", async () => {
    const findMany = vi.fn(async () => [{ id: "linked", shopifyCustomerId: "901" }]);
    const service = new RecoveryShopifyCustomerService({
      customer: { findMany },
      customerPhone: { findFirst: vi.fn(async () => ({ phone: "07400 123456" })) },
      shop: { findUnique: vi.fn(async () => ({ defaultCountryCode: "GB" })) },
    } as never);
    upsert.mockResolvedValue({ id: "linked" });
    await service.resolve(checkout, "shop-1");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ phone: "07400 123456" }));
  });

  it("preserves the exact linked identity representation and denies duplicates", async () => {
    const findMany = vi.fn().mockResolvedValueOnce([{
      id: "linked", shopifyCustomerId: "gid://shopify/Customer/901",
    }]).mockResolvedValueOnce([
      { id: "a", shopifyCustomerId: "901" },
      { id: "b", shopifyCustomerId: "gid://shopify/Customer/901" },
    ]);
    const service = new RecoveryShopifyCustomerService({
      customer: { findMany },
      customerPhone: { findFirst: vi.fn(async () => null) },
      shop: { findUnique: vi.fn(async () => ({ defaultCountryCode: "GB" })) },
    } as never);
    upsert.mockResolvedValue({ id: "linked" });
    await service.resolve(checkout, "shop-1");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ shopifyCustomerId: "gid://shopify/Customer/901" }));
    await expect(service.resolve(checkout, "shop-1")).resolves.toBeNull();
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
