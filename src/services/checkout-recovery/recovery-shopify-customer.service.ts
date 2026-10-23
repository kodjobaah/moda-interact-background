import type { PrismaClient, Customer } from "@prisma/client";
import { normalizeRecipientPhone, parseShopifyCustomerIdentity } from "@modainteract/moda-interact-shared/identity";
import type { RecoveryCheckoutSeed } from "../../events/checkout-events.js";
import prisma from "../../lib/db.js";
import { customerService } from "../customer.service.js";

/** Recovery must never link a phone-only legacy principal to Shopify by phone. */
export class RecoveryShopifyCustomerService {
  constructor(private readonly database: Pick<PrismaClient, "customer" | "customerPhone" | "shop"> = prisma) {}

  async resolve(event: RecoveryCheckoutSeed, shopId: string): Promise<Customer | null> {
    if (!event.customer?.shopifyCustomerId) return null;
    let identity: ReturnType<typeof parseShopifyCustomerIdentity>;
    try {
      identity = parseShopifyCustomerIdentity(event.customer.shopifyCustomerId);
    } catch {
      return null;
    }
    const linked = await this.database.customer.findMany({
      where: { shopId, shopifyCustomerId: { in: [identity.numericId, identity.gid] } },
      select: { id: true, shopifyCustomerId: true },
      take: 2,
    });
    // Two aliases for the same provider identity must be repaired explicitly;
    // never select an arbitrary Customer or fall back to a phone match.
    if (linked.length > 1) return null;

    let incomingPhone = event.customer.phone;
    if (linked[0] && incomingPhone) {
      const current = await this.database.customerPhone.findFirst({
        where: { customerId: linked[0].id, endedAt: null },
        orderBy: { startedAt: "desc" },
        select: { phone: true },
      });
      if (current) {
        const shop = await this.database.shop.findUnique({
          where: { id: shopId }, select: { defaultCountryCode: true },
        });
        const country = shop?.defaultCountryCode?.toUpperCase();
        const canonical = (phone: string) => normalizeRecipientPhone(
          phone,
          phone.trim().startsWith("+") ? {} :
            country ? { verifiedCountryCode: country } : {},
        );
        const before = canonical(current.phone);
        const next = canonical(incomingPhone);
        if (before.ok && next.ok && before.e164 === next.e164) {
          // Preserve the *same* active CustomerPhone row and its STOP revision.
          // A Shopify number reformat must never close a locally STOPped row.
          incomingPhone = current.phone;
        }
      }
    }
    return customerService.upsertShopifyCustomer({
      shopId,
      shopifyCustomerId: linked[0]?.shopifyCustomerId ?? identity.numericId,
      phone: incomingPhone,
      email: event.customer.email,
      firstName: event.customer.firstName,
      lastName: event.customer.lastName,
    });
  }
}

export const recoveryShopifyCustomerService = new RecoveryShopifyCustomerService();
