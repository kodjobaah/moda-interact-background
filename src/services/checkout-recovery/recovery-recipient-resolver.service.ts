import type { RecoveryCheckoutSeed } from "../../events/checkout-events.js";
import prisma from "../../lib/db.js";
import { recoveryShopifyCustomerService } from "./recovery-shopify-customer.service.js";
import { customerPhoneService } from "../customer.phone.service.js";
import { canonicalizeRecoveryRecipient } from "./recovery-recipient-canonicalization.js";

export class RecoveryRecipientResolverService {
  async resolve(event: RecoveryCheckoutSeed): Promise<string | null> {
    const shop = await prisma.shop.findUnique({
      where: { domain: event.shop }, select: { id: true },
    });
    if (!shop) return null;
    const customer = await recoveryShopifyCustomerService.resolve(event, shop.id);
    if (!customer) return null;

    const currentPhone = await customerPhoneService.getCurrentPhone(customer.id);
    return canonicalizeRecoveryRecipient(currentPhone?.phone);
  }

  async resolveForCustomerInShop(customerId: string, shopId: string): Promise<string | null> {
    const currentPhone = await customerPhoneService.getCurrentPhoneForShop(customerId, shopId);
    return canonicalizeRecoveryRecipient(currentPhone?.phone);
  }
}

export const recoveryRecipientResolverService = new RecoveryRecipientResolverService();