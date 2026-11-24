import type { Customer, PrismaClient } from "@prisma/client";
import { normalizeRecipientPhone, parseShopifyCustomerIdentity } from "@modainteract/moda-interact-shared/identity";
import type { RecoveryCheckoutSeed } from "../../events/checkout-events.js";
import prisma from "../../lib/db.js";

/** Shopify recovery customer lookup is read-only. The authenticated checkout
 * materialiser alone may create a guest or associate a Shopify ID. In particular
 * this method must never use the legacy single-phone rotation writer. */
export class RecoveryShopifyCustomerService {
  constructor(private readonly database: Pick<PrismaClient, "customer" | "customerPhone" | "shop"> = prisma) {}

  async resolve(event: RecoveryCheckoutSeed, shopId: string): Promise<Customer | null> {
    const shop = await this.database.shop.findFirst({
      where: { id: shopId, platform: "SHOPIFY", status: "ACTIVE" },
      select: { defaultCountryCode: true },
    });
    if (!shop) return null;
    const supplied = event.customer?.phone?.trim();
    if (!supplied) return null;
    const parsed = normalizeRecipientPhone(supplied,
      supplied.startsWith("+") || !shop.defaultCountryCode ? {} :
      { verifiedCountryCode: shop.defaultCountryCode.toUpperCase() });
    if (!parsed.ok) return null;
    const records = await this.database.customerPhone.findMany({
      where: { endedAt: null, whatsappCanonicalPhone: parsed.e164.slice(1), customer: { shopId } },
      include: { customer: true }, take: 2,
    });
    if (records.length !== 1) return null;
    const customer = records[0]!.customer;
    const providerId = event.customer?.shopifyCustomerId;
    if (providerId) {
      let identity: ReturnType<typeof parseShopifyCustomerIdentity>;
      try { identity = parseShopifyCustomerIdentity(providerId); } catch { return null; }
      if (customer.shopifyCustomerId && customer.shopifyCustomerId !== identity.numericId &&
          customer.shopifyCustomerId !== identity.gid) return null;
    }
    return customer;
  }
}

export const recoveryShopifyCustomerService = new RecoveryShopifyCustomerService();
