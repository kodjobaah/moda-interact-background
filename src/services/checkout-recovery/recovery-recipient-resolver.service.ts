import type { RecoveryCheckoutSeed } from "../../events/checkout-events.js";
import { customerService } from "../customer.service.js";
import { customerPhoneService } from "../customer.phone.service.js";

export class RecoveryRecipientResolverService {
  async resolve(event: RecoveryCheckoutSeed): Promise<string | null> {
    const customer = await customerService.resolveCustomer(event);
    if (!customer) return null;

    const currentPhone = await customerPhoneService.getCurrentPhone(customer.id);
    if (!currentPhone) return null;

    const digits = currentPhone.phone.replace(/\D/g, "");
    return digits.length > 0 ? digits : null;
  }
}

export const recoveryRecipientResolverService = new RecoveryRecipientResolverService();