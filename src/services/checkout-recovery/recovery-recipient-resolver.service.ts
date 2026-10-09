import type { RecoveryCheckoutSeed } from "../../events/checkout-events.js";
import { customerService } from "../customer.service.js";
import { customerPhoneService } from "../customer.phone.service.js";
import { canonicalizeRecoveryRecipient } from "./recovery-recipient-canonicalization.js";

export class RecoveryRecipientResolverService {
  async resolve(event: RecoveryCheckoutSeed): Promise<string | null> {
    const customer = await customerService.resolveCustomer(event);
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