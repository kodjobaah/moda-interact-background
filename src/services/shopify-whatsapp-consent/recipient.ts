import type { PrismaClient } from "@prisma/client";
import { normalizeRecipientPhone, parseShopifyCustomerIdentity } from "@modainteract/moda-interact-shared/identity";
import { ambiguous, notAuthorised, type Identity, type ScopedCustomer, type ScopedResult, type RecipientResult } from "./types.js";

/** Resolves only shop-owned, linked Shopify customers and unambiguous active recipients. */
export class ShopifyConsentRecipientResolver {
  constructor(private readonly database: PrismaClient) {}

  async resolveCustomer(
    shopId: string,
    shopifyCustomerId: string,
    expectedCustomerId?: string,
  ): Promise<ScopedResult> {
    let identity: Identity;
    try {
      identity = parseShopifyCustomerIdentity(shopifyCustomerId);
    } catch {
      return { ok: false, failure: notAuthorised("UNVERIFIED_SHOPIFY_IDENTITY") };
    }
    const shop = await this.database.shop.findUnique({
      where: { id: shopId },
      select: { id: true, domain: true, platform: true, status: true, defaultCountryCode: true },
    });
    if (!shop || shop.platform !== "SHOPIFY" || shop.status !== "ACTIVE") {
      return { ok: false, failure: notAuthorised("SHOP_NOT_ELIGIBLE") };
    }
    // Numeric and GraphQL GID are accepted ONLY when already linked to an
    // existing shop-owned Customer. Never merge a phone-only legacy Customer.
    const customers = await this.database.customer.findMany({
      where: { shopId, shopifyCustomerId: { in: [identity.numericId, identity.gid] } },
      select: { id: true },
      take: 2,
    });
    if (customers.length > 1) return { ok: false, failure: ambiguous("DUPLICATE_SHOPIFY_IDENTITY") };
    const customer = customers[0];
    if (!customer || (expectedCustomerId !== undefined && customer.id !== expectedCustomerId)) {
      return { ok: false, failure: notAuthorised("CUSTOMER_IDENTITY_NOT_LINKED") };
    }
    return { ok: true, value: { shop, customerId: customer.id, identity } };
  }

  async resolveCustomerById(shopId: string, customerId: string): Promise<ScopedResult> {
    const customer = await this.database.customer.findFirst({
      where: { id: customerId, shopId },
      select: { shopifyCustomerId: true },
    });
    if (!customer?.shopifyCustomerId) {
      return { ok: false, failure: notAuthorised("CUSTOMER_IDENTITY_NOT_LINKED") };
    }
    return this.resolveCustomer(shopId, customer.shopifyCustomerId, customerId);
  }

  canonical(phone: string, shop: ScopedCustomer["shop"]): string | null {
    // Never derive a national prefix from a language tag or locale.
    const country = shop.defaultCountryCode?.toUpperCase();
    const context = phone.trim().startsWith("+") ? {} :
      country ? { verifiedCountryCode: country } : {};
    const normalized = normalizeRecipientPhone(phone, context);
    return normalized.ok ? normalized.e164 : null;
  }

  async findRecipient(scoped: ScopedCustomer, recipient: string): Promise<RecipientResult> {
    const canonical = this.canonical(recipient, scoped.shop);
    if (!canonical) return { ok: false, failure: notAuthorised("INVALID_RECIPIENT") };
    const phones = await this.database.customerPhone.findMany({
      where: { customerId: scoped.customerId, endedAt: null, customer: { shopId: scoped.shop.id } },
    });
    const matching = phones.filter((phone) =>
      this.canonical(phone.phone, scoped.shop) === canonical &&
      (phone.whatsappCanonicalPhone === null || phone.whatsappCanonicalPhone === canonical.slice(1)));
    if (matching.length === 0) return { ok: false, failure: notAuthorised("ACTIVE_RECIPIENT_NOT_FOUND") };
    if (matching.length !== 1) return { ok: false, failure: ambiguous("MULTIPLE_ACTIVE_RECIPIENTS") };
    const phone = matching[0]!;
    // Do not treat another customer with the same recipient as the verified
    // principal, even if the Shopify customer ID uniquely identifies this one.
    const others = await this.database.customerPhone.findMany({
      where: {
        endedAt: null,
        customer: { shopId: scoped.shop.id },
        OR: [
          { whatsappCanonicalPhone: canonical.slice(1) },
          { phone: { in: [phone.phone, recipient, canonical] } },
        ],
      },
      select: { id: true },
      take: 2,
    });
    if (others.some((other) => other.id !== phone.id)) {
      return { ok: false, failure: ambiguous("RECIPIENT_SHARED_BY_CUSTOMERS") };
    }
    // Pre-migration legacy phones have no canonical index key. Do not silently
    // authorise a number shared in another presentation format. Bound the scan
    // and fail closed if the merchant has too many unverified legacy numbers;
    // a subsequent canonical backfill can remove this legacy ambiguity.
    const unverified = await this.database.customerPhone.findMany({
      where: { endedAt: null, whatsappCanonicalPhone: null, customer: { shopId: scoped.shop.id } },
      select: { id: true, phone: true },
      take: 251,
    });
    if (unverified.length > 250) {
      return { ok: false, failure: ambiguous("UNVERIFIED_LEGACY_RECIPIENTS") };
    }
    if (unverified.some((other) => other.id !== phone.id &&
        this.canonical(other.phone, scoped.shop) === canonical)) {
      return { ok: false, failure: ambiguous("RECIPIENT_SHARED_BY_CUSTOMERS") };
    }
    return { ok: true, phone, canonical };
  }

}
