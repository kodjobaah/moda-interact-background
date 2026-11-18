import { normalizeRecipientPhone } from "@modainteract/moda-interact-shared/identity";
import type { NormalizedAbandonedCheckout } from "../domain/abandoned-checkout.js";
import type { PendingRecoveryCandidate } from "../domain/pending-recovery-candidate.js";
import type { RecoveryCheckoutSeed } from "../events/checkout-events.js";
import { recoveryShopifyCustomerService } from "./checkout-recovery/recovery-shopify-customer.service.js";
import {
  ShopifyWhatsAppConsentService,
  type ShopifyWhatsAppConsentServicePort,
} from "./shopify-whatsapp-consent.service.js";
import { verifyShopifyConsentReceipt } from "./shopify-consent-receipt-verifier.js";
import type { ShopifyConsentMaterializationResult } from "./shopify-whatsapp-consent/types.js";

export type ShopifyCheckoutConsentMaterialization =
  | { status: "NO_EXPLICIT_CHOICE" }
  | { status: "INVALID_OR_AMBIGUOUS_RECEIPT" }
  | { status: "DEFER_CHECKOUT_BINDING" }
  | { status: "DEFER_IDENTITY_OR_RECIPIENT" }
  | { status: "BLOCKED_STOP" }
  | { status: "MATERIALISATION_FAILURE"; reason: string }
  | { status: "MATERIALISED_GRANTED"; recipient: string }
  | { status: "MATERIALISED_REVOKED" };

type CustomerPreparer = (seed: RecoveryCheckoutSeed, shopId: string) => Promise<unknown>;

/** Applies an authenticated receipt only after the caller has established recoverability. */
export class ShopifyCheckoutConsentMaterializationService {
  constructor(
    private readonly consent: Pick<ShopifyWhatsAppConsentServicePort, "materializeExplicitChoice"> =
      new ShopifyWhatsAppConsentService(),
    private readonly prepareCustomer: CustomerPreparer = (seed, shopId) =>
      recoveryShopifyCustomerService.resolve(seed, shopId),
    private readonly keyringJson: () => string | undefined = () =>
      process.env.MODA_ENCRYPTION_KEYS_JSON,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async materialize(input: {
    candidate: PendingRecoveryCandidate;
    checkout: NormalizedAbandonedCheckout;
    seed: RecoveryCheckoutSeed;
  }): Promise<ShopifyCheckoutConsentMaterialization> {
    const keyringJson = this.keyringJson();
    const verification = verifyShopifyConsentReceipt({
      attribute: input.checkout.consentReceiptAttribute,
      shopId: input.candidate.shopId,
      shopifyPlus: input.checkout.shopifyPlus,
      cartToken: input.candidate.cartToken,
      checkoutToken: input.candidate.checkoutToken,
      verifiedShopifyCustomerId: input.checkout.customer?.shopifyCustomerId ?? null,
      ...(keyringJson !== undefined ? { keyringJson } : {}),
      now: this.now(),
    });
    if (verification.status !== "VERIFIED") {
      return { status: verification.status };
    }

    const shopifyCustomerId = input.checkout.customer?.shopifyCustomerId;
    if (!shopifyCustomerId || verification.customerId === "-") {
      return { status: "DEFER_IDENTITY_OR_RECIPIENT" };
    }

    const chosen = selectAttributedRecipient(input.checkout);
    if (!chosen) return { status: "DEFER_IDENTITY_OR_RECIPIENT" };
    const seed: RecoveryCheckoutSeed = {
      ...input.seed,
      customer: { ...input.seed.customer, phone: chosen.phone },
    };

    // A customer or billing phone can be attached to the authenticated
    // Shopify customer. Shipping-only numbers must already be attributable to
    // that customer's durable CustomerPhone row; never create a principal from
    // a shipping destination.
    if (chosen.source !== "shipping") {
      const customer = await this.prepareCustomer(seed, input.candidate.shopId);
      if (!customer) return { status: "DEFER_IDENTITY_OR_RECIPIENT" };
    }

    const result: ShopifyConsentMaterializationResult =
      await this.consent.materializeExplicitChoice({
        shopId: input.candidate.shopId,
        shopifyCustomerId,
        recipient: chosen.e164,
        decision: verification.decision,
      });
    switch (result.status) {
      case "MATERIALISED_GRANTED":
        return { status: result.status, recipient: chosen.e164.slice(1) };
      case "MATERIALISED_REVOKED":
      case "BLOCKED_STOP":
      case "DEFER_IDENTITY_OR_RECIPIENT":
      case "MATERIALISATION_FAILURE":
        return result;
    }
  }
}

function selectAttributedRecipient(
  checkout: NormalizedAbandonedCheckout,
): { source: "customer" | "billing" | "shipping"; phone: string; e164: string } | null {
  const country = checkout.internationalContext.countryCode ?? undefined;
  const choices = [
    { source: "customer" as const, phone: checkout.customer?.phone },
    { source: "billing" as const, phone: checkout.billingPhone },
    { source: "shipping" as const, phone: checkout.shippingPhone },
  ];
  for (const choice of choices) {
    if (!choice.phone?.trim()) continue;
    const normalized = normalizeRecipientPhone(
      choice.phone,
      choice.phone.trim().startsWith("+") || !country
        ? {}
        : { verifiedCountryCode: country },
    );
    if (normalized.ok) {
      return { source: choice.source, phone: choice.phone, e164: normalized.e164 };
    }
  }
  return null;
}

export const shopifyCheckoutConsentMaterializationService =
  new ShopifyCheckoutConsentMaterializationService();
