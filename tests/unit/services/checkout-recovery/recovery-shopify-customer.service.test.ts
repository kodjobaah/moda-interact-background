import { describe, expect, it, vi } from "vitest";
import { RecoveryShopifyCustomerService } from "../../../../src/services/checkout-recovery/recovery-shopify-customer.service.js";

const checkout = {
  shop: "test.myshopify.com",
  checkoutToken: "checkout-1",
  customer: {
    shopifyCustomerId: "gid://shopify/Customer/901",
    phone: "+447400123456",
    email: null,
    firstName: null,
    lastName: null,
  },
} as never;

function service(
  phones: Array<{ customer: { id: string; shopifyCustomerId: string | null } }>,
) {
  const db = {
    shop: { findFirst: vi.fn(async () => ({ defaultCountryCode: "GB" })) },
    customerPhone: { findMany: vi.fn(async () => phones) },
    customer: {},
  };
  return { subject: new RecoveryShopifyCustomerService(db as never), db };
}

describe("Shopify recovery customer lookup", () => {
  it("resolves the unique Moda customer from the canonical phone without creating a customer", async () => {
    const { subject, db } = service([
      { customer: { id: "guest-1", shopifyCustomerId: null } },
    ]);
    await expect(subject.resolve(checkout, "shop-1")).resolves.toMatchObject({
      id: "guest-1",
    });
    expect(db.customerPhone.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          endedAt: null,
          whatsappCanonicalPhone: "447400123456",
          customer: { shopId: "shop-1" },
        },
        take: 2,
      }),
    );
  });

  it("rejects a phone already associated with a different Shopify identity", async () => {
    const { subject } = service([
      { customer: { id: "other", shopifyCustomerId: "902" } },
    ]);
    await expect(subject.resolve(checkout, "shop-1")).resolves.toBeNull();
  });

  it("fails closed for multiple merchant phone matches", async () => {
    const { subject } = service([
      { customer: { id: "a", shopifyCustomerId: null } },
      { customer: { id: "b", shopifyCustomerId: null } },
    ]);
    await expect(subject.resolve(checkout, "shop-1")).resolves.toBeNull();
  });

  it("does not manufacture an identity from a missing checkout phone", async () => {
    const { subject, db } = service([]);
    await expect(
      subject.resolve(
        {
          ...checkout,
          customer: {
            ...checkout.customer,
            phone: null,
          },
        } as never,
        "shop-1",
      ),
    ).resolves.toBeNull();
    expect(db.customerPhone.findMany).not.toHaveBeenCalled();
  });
});
