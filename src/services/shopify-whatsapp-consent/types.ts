import type { CustomerPhone, Shop } from "@prisma/client";
import type { parseShopifyCustomerIdentity } from "@modainteract/moda-interact-shared/identity";

export type ShopifyWhatsAppConsentEligibility =
  | {
      status: "ALLOWED";
      customerPhoneId: string;
      canonicalRecipient: string;
      consentRevision: bigint;
      noContactRevision: bigint;
    }
  | { status: "NOT_AUTHORISED"; reason: string }
  | { status: "UNAVAILABLE"; reason: string }
  | { status: "AMBIGUOUS"; reason: string };

export type ShopifyWhatsAppConsentSyncResult =
  | { status: "UPDATED" | "UNCHANGED"; customerPhoneId: string }
  | { status: "NOT_AUTHORISED" | "UNAVAILABLE" | "AMBIGUOUS"; reason: string };

export type Failure = Extract<ShopifyWhatsAppConsentEligibility, { status: "NOT_AUTHORISED" | "UNAVAILABLE" | "AMBIGUOUS" }>;
export type Identity = ReturnType<typeof parseShopifyCustomerIdentity>;
export type ScopedCustomer = {
  shop: Pick<Shop, "id" | "domain" | "defaultCountryCode">;
  customerId: string;
  identity: Identity;
};
export type ScopedResult = { ok: true; value: ScopedCustomer } | { ok: false; failure: Failure };
export type RecipientResult =
  | { ok: true; phone: CustomerPhone; canonical: string }
  | { ok: false; failure: Failure };
export type RefreshResult = ShopifyWhatsAppConsentSyncResult;
export type InvalidationResult = {
  failure: Failure | null;
  hasNewerDisplacedObservation: boolean;
};

export const notAuthorised = (reason: string): Failure => ({ status: "NOT_AUTHORISED", reason });
export const unavailable = (reason: string): Failure => ({ status: "UNAVAILABLE", reason });
export const ambiguous = (reason: string): Failure => ({ status: "AMBIGUOUS", reason });
