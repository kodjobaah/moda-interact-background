import { createHash } from "node:crypto";
import { Prisma, type CustomerPhone, type PrismaClient } from "@prisma/client";
import { normalizeRecipientPhone, parseShopifyCustomerIdentity } from "@modainteract/moda-interact-shared/identity";
import prisma from "../../lib/db.js";
import type { NormalizedAbandonedCheckout } from "../../domain/abandoned-checkout.js";

export type CheckoutPhoneSource = "customer" | "billing" | "shipping" | "previous";
export type CheckoutPhone = Readonly<{
  canonicalRecipient: string; source: Exclude<CheckoutPhoneSource, "previous">; priority: 1 | 2 | 3;
}>;
export type CheckoutPhones = Readonly<{ valid: readonly CheckoutPhone[]; invalidSources: readonly string[] }>;
export type ShopifySelectedPhone = Readonly<{
  customerId: string; customerPhoneId: string; recipient: string; source: CheckoutPhoneSource;
}>;
export type ShopifyPhoneDecisionResult = Readonly<{
  customerId: string; selected: ShopifySelectedPhone | null; consentWriteCount: number;
  evidenceInsertedCount: number; validPhoneCount: number; invalidSources: readonly string[];
}>;

export class ShopifyPhoneResolutionError extends Error {
  constructor(readonly reasonCode: "SHOP_UNAVAILABLE" | "CUSTOMER_CONFLICT" |
    "RECIPIENT_AMBIGUOUS" | "PHONE_MISSING" | "STALE_RECEIPT" | "EVIDENCE_CONFLICT", message: string) {
    super(message);
    this.name = "ShopifyPhoneResolutionError";
  }
}

const disclosureText = "Send me WhatsApp shopping updates, reminders and offers.";

/** Shopify checkout phone sources are shopper-provided under ARCH-077 v1. */
export function collectShopifyCheckoutPhones(checkout: NormalizedAbandonedCheckout): CheckoutPhones {
  const entries = [
    { source: "customer" as const, priority: 1 as const, phone: checkout.customer?.phone,
      country: checkout.internationalContext.countryCode },
    { source: "billing" as const, priority: 2 as const, phone: checkout.billingPhone,
      country: checkout.billingCountryCode },
    { source: "shipping" as const, priority: 3 as const, phone: checkout.shippingPhone,
      country: checkout.shippingCountryCode },
  ];
  const seen = new Set<string>();
  const valid: CheckoutPhone[] = [];
  const invalidSources: string[] = [];
  for (const entry of entries) {
    if (!entry.phone?.trim()) continue;
    const phone = entry.phone.trim();
    const normalized = normalizeRecipientPhone(phone,
      phone.startsWith("+") || !entry.country ? {} : { verifiedCountryCode: entry.country });
    if (!normalized.ok) {
      invalidSources.push(entry.source);
      continue;
    }
    const canonicalRecipient = normalized.e164.slice(1);
    if (seen.has(canonicalRecipient)) continue;
    seen.add(canonicalRecipient);
    valid.push({ canonicalRecipient, source: entry.source, priority: entry.priority });
  }
  return { valid, invalidSources };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireShopifyIdentity(value: string | null): { numericId: string; gid: string } | null {
  if (!value) return null;
  try { return parseShopifyCustomerIdentity(value); }
  catch { throw new ShopifyPhoneResolutionError("CUSTOMER_CONFLICT", "Invalid authoritative Shopify identity"); }
}

async function readMatchingShopifyCustomers(tx: Prisma.TransactionClient, shopId: string,
  identity: { numericId: string; gid: string } | null, phones: readonly CheckoutPhone[]) {
  const linked = identity ? await tx.customer.findMany({
    where: { shopId, shopifyCustomerId: { in: [identity.numericId, identity.gid] } }, take: 2,
  }) : [];
  if (linked.length > 1) throw new ShopifyPhoneResolutionError("CUSTOMER_CONFLICT", "Conflicting Shopify identity aliases");
  const matched = phones.length ? await tx.customerPhone.findMany({
    where: { endedAt: null, whatsappCanonicalPhone: { in: phones.map(p => p.canonicalRecipient) },
      customer: { shopId } },
    include: { customer: true },
  }) : [];
  for (const phone of phones) {
    if (matched.filter(row => row.whatsappCanonicalPhone === phone.canonicalRecipient).length > 1) {
      throw new ShopifyPhoneResolutionError("RECIPIENT_AMBIGUOUS", "More than one active phone record in merchant");
    }
  }
  const candidateIds = new Set(matched.map(row => row.customerId));
  if (candidateIds.size > 1 || (linked[0] && candidateIds.size && !candidateIds.has(linked[0].id))) {
    throw new ShopifyPhoneResolutionError("CUSTOMER_CONFLICT", "Shopify checkout numbers belong to conflicting Moda customers");
  }
  const customer = linked[0] ?? matched[0]?.customer ?? null;
  if (customer?.shopifyCustomerId && identity &&
      customer.shopifyCustomerId !== identity.numericId && customer.shopifyCustomerId !== identity.gid) {
    throw new ShopifyPhoneResolutionError("CUSTOMER_CONFLICT", "Phone belongs to another Shopify identity");
  }
  return { customer, matched };
}

/** Current permission is the phone row; matching immutable evidence is compulsory. */
export async function isEligibleShopifyPhone(
  tx: Pick<Prisma.TransactionClient, "whatsAppConsentEvidence">,
  shopId: string, customerId: string, row: CustomerPhone,
): Promise<boolean> {
  if (row.endedAt || !row.whatsappCanonicalPhone || row.whatsappNoContact || row.whatsappNoContactReason ||
      row.whatsappConsentPurpose !== "WHATSAPP_CHECKOUT_RECOVERY" ||
      row.whatsappConsentSource !== "SHOPIFY_NATIVE" || row.whatsappConsentDecision !== "GRANTED" ||
      row.whatsappConsentRevision <= 0n || row.whatsappConsentDecisionSequence <= 0n ||
      !row.whatsappPhoneVerifiedAt || !row.whatsappConsentVerifiedAt || !row.whatsappConsentProviderObservedAt ||
      row.whatsappConsentVerifiedAt < row.whatsappConsentProviderObservedAt ||
      row.whatsappConsentVerifiedAt < row.whatsappPhoneVerifiedAt) return false;
  const evidence = await tx.whatsAppConsentEvidence.findFirst({
    where: { shopId, customerId, customerPhoneId: row.id, canonicalPhone: row.whatsappCanonicalPhone,
      installationId: null, decision: "GRANT", phoneConsentRevision: row.whatsappConsentRevision,
      decisionSequence: row.whatsappConsentDecisionSequence, decisionAt: row.whatsappConsentProviderObservedAt },
    select: { id: true },
  });
  return evidence !== null;
}

async function pickSelected(tx: Prisma.TransactionClient, shopId: string, customerId: string,
  current: readonly CheckoutPhone[]): Promise<ShopifySelectedPhone | null> {
  const rows = await tx.customerPhone.findMany({ where: { customerId, endedAt: null, customer: { shopId } } });
  const currentByNumber = new Map(current.map(phone => [phone.canonicalRecipient, phone]));
  const ordered = [...rows].sort((a,b) => {
    const first = currentByNumber.get(a.whatsappCanonicalPhone ?? "");
    const second = currentByNumber.get(b.whatsappCanonicalPhone ?? "");
    if (first || second) return (first?.priority ?? 4) - (second?.priority ?? 4);
    const dateDifference = (b.whatsappConsentVerifiedAt?.getTime() ?? 0) -
      (a.whatsappConsentVerifiedAt?.getTime() ?? 0);
    return dateDifference || (a.whatsappCanonicalPhone ?? "").localeCompare(b.whatsappCanonicalPhone ?? "");
  });
  for (const row of ordered) {
    if (!await isEligibleShopifyPhone(tx, shopId, customerId, row)) continue;
    const source = currentByNumber.get(row.whatsappCanonicalPhone ?? "")?.source ?? "previous";
    return { customerId, customerPhoneId: row.id, recipient: row.whatsappCanonicalPhone!, source };
  }
  return null;
}

/** No receipt: read previously applied consent, do not create customer/permission. */
export async function selectStoredShopifyCheckoutPhone(input: {
  shopId: string; checkout: NormalizedAbandonedCheckout; database?: PrismaClient;
}): Promise<ShopifySelectedPhone | null> {
  const database = input.database ?? prisma;
  const phones = collectShopifyCheckoutPhones(input.checkout).valid;
  const identity = requireShopifyIdentity(input.checkout.customer?.shopifyCustomerId ?? null);
  return database.$transaction(async tx => {
    const { customer } = await readMatchingShopifyCustomers(tx, input.shopId, identity, phones);
    if (!customer) return null;
    return pickSelected(tx, input.shopId, customer.id, phones);
  });
}

/** An explicit, authenticated receipt is already verified at the calling boundary. */
export async function materializeShopifyCheckoutPhones(input: {
  shopId: string; checkout: NormalizedAbandonedCheckout; decision: "GRANTED" | "REVOKED";
  acceptedAt: number; locale: string; receiptValue: string; checkoutToken: string;
  cartToken: string | null; receiptKind: "c" | "x"; now: Date; database?: PrismaClient;
}): Promise<ShopifyPhoneDecisionResult> {
  const database = input.database ?? prisma;
  const collected = collectShopifyCheckoutPhones(input.checkout);
  if (collected.valid.length === 0) throw new ShopifyPhoneResolutionError("PHONE_MISSING", "No valid Shopify checkout phone");
  const identity = requireShopifyIdentity(input.checkout.customer?.shopifyCustomerId ?? null);
  const observedAt = new Date(input.acceptedAt * 1000);
  if (!Number.isFinite(observedAt.getTime()) || observedAt.getTime() > input.now.getTime() + 300_000) {
    throw new ShopifyPhoneResolutionError("STALE_RECEIPT", "Invalid Shopify consent observation timestamp");
  }
  const verifiedAt = input.now.getTime() < observedAt.getTime() ? observedAt : input.now;
  const binding = input.receiptKind === "c" ? input.cartToken : input.checkoutToken;
  if (!binding) throw new ShopifyPhoneResolutionError("STALE_RECEIPT", "Signed Shopify receipt has no authenticated binding");
  const bindingDigest = sha256(binding);
  const receiptDigest = sha256(input.receiptValue);
  return database.$transaction(async tx => {
    const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "commerce"."Shop" WHERE "id"=$1 FOR UPDATE`, input.shopId);
    if (locked.length !== 1) throw new ShopifyPhoneResolutionError("SHOP_UNAVAILABLE", "Shop unavailable for Shopify consent");
    const shop = await tx.shop.findUnique({ where: { id: input.shopId },
      select: { platform: true, status: true } });
    if (shop?.platform !== "SHOPIFY" || shop.status !== "ACTIVE") {
      throw new ShopifyPhoneResolutionError("SHOP_UNAVAILABLE", "Shop not eligible for Shopify consent");
    }
    const { customer: existing, matched } = await readMatchingShopifyCustomers(
      tx, input.shopId, identity, collected.valid);
    const customer = existing ?? await tx.customer.create({ data: {
      shopId: input.shopId, shopifyCustomerId: identity?.numericId ?? null,
      email: input.checkout.customer?.email ?? null,
      firstName: input.checkout.customer?.firstName ?? null,
      lastName: input.checkout.customer?.lastName ?? null,
    } });
    if (existing && identity && !existing.shopifyCustomerId) {
      await tx.customer.update({ where: { id: customer.id }, data: { shopifyCustomerId: identity.numericId } });
    }
    let consentWriteCount = 0;
    let evidenceInsertedCount = 0;
    for (const phone of collected.valid) {
      let record = matched.find(row => row.whatsappCanonicalPhone === phone.canonicalRecipient);
      if (!record) {
        record = await tx.customerPhone.create({ data: {
          customerId: customer.id, phone: `+${phone.canonicalRecipient}`,
          whatsappCanonicalPhone: phone.canonicalRecipient,
        }, include: { customer: true } });
      }
      const eventId = sha256(JSON.stringify([
        "shopify-checkout-consent", 1, input.shopId, bindingDigest, receiptDigest, phone.canonicalRecipient,
      ]));
      const eventPayload = JSON.stringify([eventId, input.decision, phone.canonicalRecipient, input.locale]);
      const payloadDigest = createHash("sha256").update(eventPayload, "utf8").digest();
      const replay = await tx.whatsAppConsentEvidence.findUnique({
        where: { shopId_eventId: { shopId: input.shopId, eventId } }, select: { payloadDigest: true },
      });
      if (replay) {
        if (!Buffer.from(replay.payloadDigest).equals(payloadDigest)) {
          throw new ShopifyPhoneResolutionError("EVIDENCE_CONFLICT", "Conflicting Shopify consent receipt replay");
        }
        continue;
      }
      const existingEvidence = await tx.whatsAppConsentEvidence.findFirst({
        where: { customerPhoneId: record.id, shopId: input.shopId,
          phoneConsentRevision: record.whatsappConsentRevision, decisionSequence: record.whatsappConsentDecisionSequence,
          decision: input.decision === "GRANTED" ? "GRANT" : "REVOKE" }, select: { id: true },
      });
      if (record.whatsappConsentDecision === input.decision &&
          record.whatsappConsentSource === "SHOPIFY_NATIVE" && existingEvidence) continue;
      const previousTime = record.whatsappConsentProviderObservedAt;
      if (previousTime && observedAt <= previousTime) {
        throw new ShopifyPhoneResolutionError("STALE_RECEIPT", "Shopify consent observation must advance");
      }
      const nextRevision = record.whatsappConsentRevision + 1n;
      const nextSequence = record.whatsappConsentDecisionSequence + 1n;
      record = await tx.customerPhone.update({ where: { id: record.id }, data: {
        whatsappConsentPurpose: "WHATSAPP_CHECKOUT_RECOVERY",
        whatsappConsentDecision: input.decision,
        whatsappConsentSource: "SHOPIFY_NATIVE",
        whatsappCanonicalPhone: phone.canonicalRecipient,
        whatsappPhoneVerifiedAt: verifiedAt,
        whatsappConsentProviderObservedAt: observedAt,
        whatsappConsentVerifiedAt: verifiedAt,
        whatsappConsentRevision: nextRevision,
        whatsappConsentDecisionSequence: nextSequence,
      }, include: { customer: true } });
      await tx.whatsAppConsentEvidence.create({ data: {
        shopId: input.shopId, installationId: null, eventId, payloadDigest,
        customerId: customer.id, customerPhoneId: record.id,
        canonicalPhone: phone.canonicalRecipient,
        decision: input.decision === "GRANTED" ? "GRANT" : "REVOKE",
        decisionSequence: nextSequence, phoneConsentRevision: nextRevision,
        decisionAt: observedAt, disclosureText, disclosureVersion: "1", disclosureLocale: input.locale,
      } });
      consentWriteCount++;
      evidenceInsertedCount++;
    }
    return { customerId: customer.id,
      selected: await pickSelected(tx, input.shopId, customer.id, collected.valid),
      consentWriteCount, evidenceInsertedCount, validPhoneCount: collected.valid.length,
      invalidSources: collected.invalidSources };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function selectStoredShopifyCustomerPhone(input: {
  shopId: string; customerId: string; database?: PrismaClient;
}): Promise<ShopifySelectedPhone | null> {
  const database = input.database ?? prisma;
  return database.$transaction(async tx => {
    const customer = await tx.customer.findFirst({ where: { id: input.customerId, shopId: input.shopId } });
    if (!customer) return null;
    return pickSelected(tx, input.shopId, customer.id, []);
  });
}

export async function evaluateShopifyStoredRecipient(input: {
  shopId: string; customerId: string; recipient: string; database?: PrismaClient;
}): Promise<
  | { status: "ALLOWED"; customerPhoneId: string; canonicalRecipient: string;
      consentRevision: bigint; noContactRevision: bigint }
  | { status: "NOT_AUTHORISED" | "AMBIGUOUS"; reason: string }
> {
  const database = input.database ?? prisma;
  const canonical = input.recipient.trim().replace(/^\+/, "");
  if (!/^[1-9][0-9]{1,14}$/.test(canonical)) return { status: "NOT_AUTHORISED", reason: "INVALID_RECIPIENT" };
  const candidates = await database.customerPhone.findMany({
    where: { endedAt: null, whatsappCanonicalPhone: canonical, customer: { shopId: input.shopId } },
    take: 3,
  });
  if (candidates.length > 1) return { status: "AMBIGUOUS", reason: "RECIPIENT_SHARED_BY_CUSTOMERS" };
  const row = candidates[0];
  if (!row || row.customerId !== input.customerId) return { status: "NOT_AUTHORISED", reason: "RECIPIENT_NOT_ATTACHED" };
  if (!await isEligibleShopifyPhone(database, input.shopId, input.customerId, row)) {
    return { status: "NOT_AUTHORISED", reason: row.whatsappNoContact ? "LOCAL_NO_CONTACT" : "CONSENT_NOT_GRANTED_OR_EVIDENCED" };
  }
  return { status: "ALLOWED", customerPhoneId: row.id, canonicalRecipient: canonical,
    consentRevision: row.whatsappConsentRevision, noContactRevision: row.whatsappNoContactRevision };
}
