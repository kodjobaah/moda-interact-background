import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  customerPhone: { findFirst: vi.fn() },
}));

vi.mock("../../../src/lib/db.js", () => ({ default: prisma }));

import { customerPhoneService } from "../../../src/services/customer.phone.service.js";

describe("CustomerPhoneService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves a current phone only for the requested customer and Shop", async () => {
    prisma.customerPhone.findFirst.mockResolvedValue({ phone: "+44 7700 900123" });

    await expect(customerPhoneService.getCurrentPhoneForShop("customer-a", "shop-a"))
      .resolves.toEqual({ phone: "+44 7700 900123" });

    expect(prisma.customerPhone.findFirst).toHaveBeenCalledWith({
      where: {
        customerId: "customer-a",
        endedAt: null,
        customer: { shopId: "shop-a" },
      },
      orderBy: { startedAt: "desc" },
    });
  });
});