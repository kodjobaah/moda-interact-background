import type { RecoveryCheckoutSeed } from "../../events/checkout-events.js";
import prisma from "../../lib/db.js";
import { recoveryShopifyCustomerService } from "./recovery-shopify-customer.service.js";
import { selectStoredShopifyCustomerPhone } from "../shopify-whatsapp-consent/phone-resolution.js";
import { canonicalizeRecoveryRecipient } from "./recovery-recipient-canonicalization.js";

export class RecoveryRecipientResolverService {
  async resolve(event: RecoveryCheckoutSeed): Promise<string | null> {
    const shop = await prisma.shop.findUnique({
      where: { domain: event.shop }, select: { id: true },
    });
    if (!shop) return null;
    const customer = await recoveryShopifyCustomerService.resolve(event, shop.id);
    if (!customer) return null;

    const selected = await selectStoredShopifyCustomerPhone({ customerId: customer.id, shopId: shop.id });
    return canonicalizeRecoveryRecipient(selected?.recipient);
  }

  async resolveForCustomerInShop(customerId: string, shopId: string): Promise<string | null> {
    const selected = await selectStoredShopifyCustomerPhone({ customerId, shopId });
    return canonicalizeRecoveryRecipient(selected?.recipient);
  }
}

export const recoveryRecipientResolverService = new RecoveryRecipientResolverService();