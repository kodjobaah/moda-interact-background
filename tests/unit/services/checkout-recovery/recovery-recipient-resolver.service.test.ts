import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  customer: { resolveCustomer: vi.fn() },
  phone: {
    getCurrentPhone: vi.fn(),
    getCurrentPhoneForShop: vi.fn(),
  },
}));

vi.mock("../../../../src/services/customer.service.js", () => ({ customerService: mocks.customer }));
vi.mock("../../../../src/services/customer.phone.service.js", () => ({ customerPhoneService: mocks.phone }));

import { RecoveryRecipientResolverService } from "../../../../src/services/checkout-recovery/recovery-recipient-resolver.service.js";

describe("RecoveryRecipientResolverService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("canonicalizes the current BACKGROUND-007 phone to bounded digits", async () => {
    mocks.customer.resolveCustomer.mockResolvedValue({ id: "customer-a" });
    mocks.phone.getCurrentPhone.mockResolvedValue({ phone: "+44 (0)20 7946 0958" });

    await expect(new RecoveryRecipientResolverService().resolve({ shop: "shop-a" } as never))
      .resolves.toBe("4402079460958");
  });

  it.each([null, "", "+12345678901234567890123456789012345678901234567890123456789012345"])(
    "rejects missing or overlong recipient %s",
    async (phone) => {
      mocks.phone.getCurrentPhoneForShop.mockResolvedValue(phone === null ? null : { phone });

      await expect(new RecoveryRecipientResolverService().resolveForCustomerInShop("customer-a", "shop-a"))
        .resolves.toBeNull();
      expect(mocks.phone.getCurrentPhoneForShop).toHaveBeenCalledWith("customer-a", "shop-a");
    },
  );

  it("returns the canonical phone for the supplied Shop-scoped CustomerPhone", async () => {
    mocks.phone.getCurrentPhoneForShop.mockResolvedValue({ phone: "+1 (555) 123-4567" });

    await expect(new RecoveryRecipientResolverService().resolveForCustomerInShop("customer-a", "shop-a"))
      .resolves.toBe("15551234567");
  });
});