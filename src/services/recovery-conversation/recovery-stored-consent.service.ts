import type { PrismaClient } from "@prisma/client";
import prisma from "../../lib/db.js";
import { canonicalWhatsAppSender } from "../whatsapp-contact-opt-out/phone.js";
import {
  ShopifyWhatsAppConsentService,
  type ShopifyWhatsAppConsentServicePort,
} from "../shopify-whatsapp-consent.service.js";
import { rows, type RecoveryContext, type SqlTransaction } from "./recovery-conversation.sql.js";

/** A pre-provider snapshot, deliberately not a persistent permission token.
 * The final Shop-locked SQL fence checks the same phone and both revisions.
 */
export type StoredRecoveryConsentSnapshot = {
  customerPhoneId: string;
  canonicalRecipient: string;
  consentRevision: bigint;
  noContactRevision: bigint;
};

export type StoredRecoveryConsentDecision =
  | { kind: "allowed"; snapshot: StoredRecoveryConsentSnapshot | null }
  | { kind: "denied"; reason: string };

export type StoredRecoveryConsentReader = Pick<RecoveryStoredConsentService, "preflight">;

export class RecoveryStoredConsentService {
  constructor(
    private readonly database: Pick<PrismaClient, "checkoutRecovery"> = prisma,
    private readonly shopify: Pick<ShopifyWhatsAppConsentServicePort, "evaluateStoredRecipient"> =
      new ShopifyWhatsAppConsentService(),
  ) {}

  /** No Shopify GraphQL read: new checkout verification belongs to BG002. */
  async preflight(input: { shopId: string; recoveryId: string; recipient: string }): Promise<StoredRecoveryConsentDecision> {
    try {
      const recovery = await this.database.checkoutRecovery.findUnique({
        where: { id: input.recoveryId },
        select: { shopId: true, customerId: true, shop: { select: { platform: true } } },
      });
      if (!recovery || recovery.shopId !== input.shopId) return { kind: "denied", reason: "recovery-unavailable" };
      // WooCommerce's separately owned ARCH-046 policy is not replaced with
      // an invented Shopify-native consent requirement.
      if (recovery.shop.platform === "WOOCOMMERCE") return { kind: "allowed", snapshot: null };
      if (recovery.shop.platform !== "SHOPIFY" || !recovery.customerId)
        return { kind: "denied", reason: "stored-consent-unavailable" };
      const canonical = canonicalWhatsAppSender(input.recipient);
      if (!canonical) return { kind: "denied", reason: "recipient-unverified" };
      const decision = await this.shopify.evaluateStoredRecipient({
        shopId: input.shopId, customerId: recovery.customerId, recipient: input.recipient,
      });
      if (decision.status !== "ALLOWED") return {
        kind: "denied", reason: decision.status === "UNAVAILABLE" ? "stored-consent-unavailable" : "stored-consent-denied",
      };
      if (decision.canonicalRecipient !== canonical) return { kind: "denied", reason: "recipient-changed" };
      return { kind: "allowed", snapshot: {
        customerPhoneId: decision.customerPhoneId,
        canonicalRecipient: decision.canonicalRecipient,
        consentRevision: decision.consentRevision,
        noContactRevision: decision.noContactRevision,
      } };
    } catch {
      return { kind: "denied", reason: "stored-consent-unavailable" };
    }
  }
}

export const recoveryStoredConsentService = new RecoveryStoredConsentService();

type PhoneFenceRow = {
  id: string; whatsappCanonicalPhone: string | null;
  whatsappConsentPurpose: string; whatsappConsentDecision: string;
  whatsappConsentSource: string | null; whatsappConsentVerifiedAt: Date | null;
  whatsappConsentProviderObservedAt: Date | null; whatsappPhoneVerifiedAt: Date | null;
  whatsappConsentRevision: bigint; whatsappConsentDecisionSequence: bigint;
  whatsappNoContact: boolean; whatsappNoContactReason: string | null;
  whatsappNoContactRevision: bigint;
};

/** Must run after the Shop lock, in the same short SQL transaction as the
 * provider-dispatch permit. No provider, Redis or outside-network operations.
 */
export async function checkFinalStoredRecoveryConsent(
  tx: SqlTransaction,
  context: RecoveryContext,
  recipient: string,
  snapshot: StoredRecoveryConsentSnapshot | undefined,
): Promise<string | null> {
  if (!snapshot) return "stored-consent-snapshot-missing";
  const canonical = canonicalWhatsAppSender(recipient);
  if (!canonical || canonical !== snapshot.canonicalRecipient) return "recipient-changed";
  const phones = await rows<PhoneFenceRow>(tx, `
    SELECT p."id", p."whatsappCanonicalPhone", p."whatsappConsentPurpose"::text,
      p."whatsappConsentDecision"::text, p."whatsappConsentSource"::text,
      p."whatsappConsentVerifiedAt", p."whatsappConsentProviderObservedAt", p."whatsappPhoneVerifiedAt",
      p."whatsappConsentRevision", p."whatsappConsentDecisionSequence",
      p."whatsappNoContact", p."whatsappNoContactReason"::text, p."whatsappNoContactRevision"
    FROM "commerce"."CheckoutRecovery" r
    JOIN "commerce"."Customer" c ON c."id"=r."customerId" AND c."shopId"=r."shopId"
    JOIN "commerce"."CustomerPhone" p ON p."customerId"=c."id" AND p."endedAt" IS NULL
    WHERE r."id"=$1 AND r."shopId"=$2 AND p."whatsappCanonicalPhone"=$3
    ORDER BY p."id" LIMIT 2 FOR SHARE OF p`, context.recoveryId, context.shopId, canonical);
  if (phones.length !== 1) return "stored-consent-ambiguous";
  const phone = phones[0]!;
  if (phone.id !== snapshot.customerPhoneId || phone.whatsappCanonicalPhone !== canonical)
    return "recipient-changed";
  if (phone.whatsappConsentRevision !== snapshot.consentRevision ||
      phone.whatsappNoContactRevision !== snapshot.noContactRevision)
    return "stored-consent-revision-changed";
  if (phone.whatsappNoContact || phone.whatsappNoContactReason !== null)
    return "local-no-contact";
  if (phone.whatsappConsentPurpose !== "WHATSAPP_CHECKOUT_RECOVERY" ||
      phone.whatsappConsentDecision !== "GRANTED" || phone.whatsappConsentSource !== "SHOPIFY_NATIVE" ||
      phone.whatsappConsentRevision <= 0n || phone.whatsappConsentDecisionSequence <= 0n ||
      !phone.whatsappConsentVerifiedAt || !phone.whatsappConsentProviderObservedAt || !phone.whatsappPhoneVerifiedAt ||
      phone.whatsappConsentVerifiedAt < phone.whatsappConsentProviderObservedAt ||
      phone.whatsappConsentVerifiedAt < phone.whatsappPhoneVerifiedAt)
    return "stored-consent-denied";
  return null;
}
