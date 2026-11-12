import { Prisma } from "@prisma/client";
import { canonicalWhatsAppSender, matchesRegisteredPhone } from "./whatsapp-contact-opt-out/phone.js";

export const recoveryRecipientCustomerSelect = {
  id: true, shopId: true, phone: true, firstName: true,
  phones: { where: { endedAt: null }, take: 2, select: {
    phone: true, whatsappCanonicalPhone: true, whatsappNoContact: true, whatsappNoContactReason: true,
  } },
  _count: { select: { phones: true } },
} as const;
export const recoveryRecipientAttemptsSelect = {
  where: { sequence: 1 }, take: 1, select: {
    recipient: true, sentAt: true,
    outboundMessage: { select: { providerMessageId: true, sentAt: true, conversationId: true, direction: true } },
  },
} as const;

type RecoveryOwner = {
  shopId: string;
  shop: { defaultCountryCode?: string | null };
  customer: {
    shopId?: string; phone: string | null;
    phones?: Array<{ phone: string; whatsappCanonicalPhone: string | null; whatsappNoContact: boolean; whatsappNoContactReason?: string | null }>;
    _count?: { phones: number };
  } | null;
  outreachAttempts?: Array<{
    recipient: string; sentAt: Date | null;
    outboundMessage: { providerMessageId: string | null; sentAt: Date | null; conversationId: string; direction: string } | null;
  }>;
};
const legacyCanonical = (phone: string) => phone.trim().replace(/^\+/, "");

/** Current phone ownership and sent outreach must name the same recipient.
 * A phone change must never transfer an old recovery to its new number.
 */
export function resolveRecoveryRecipient(owner: RecoveryOwner, conversationId: string): string | null {
  const customer = owner.customer;
  if (!customer || (customer.shopId !== undefined && customer.shopId !== owner.shopId)) return null;
  const phones = customer.phones ?? [];
  const initial = owner.outreachAttempts?.[0];
  const sentRecipient = initial?.sentAt && initial.outboundMessage?.sentAt &&
    initial.outboundMessage.providerMessageId && initial.outboundMessage.direction === "OUTBOUND" &&
    initial.outboundMessage.conversationId === conversationId
    ? canonicalWhatsAppSender(initial.recipient) : null;
  if (phones.length || (customer._count?.phones ?? 0) > 0) {
    if (phones.length !== 1 || phones[0]!.whatsappNoContact || phones[0]!.whatsappNoContactReason || !sentRecipient ||
        !matchesRegisteredPhone(phones[0]!, sentRecipient, owner.shop.defaultCountryCode)) return null;
    return `+${sentRecipient}`;
  }
  // Compatibility for pre-CustomerPhone recoveries only. A displaced/ended
  // CustomerPhone is history, never permission to revive Customer.phone.
  if (!customer.phone) return null;
  const legacy = legacyCanonical(customer.phone);
  if (initial && (!sentRecipient || sentRecipient !== legacy)) return null;
  return legacy ? customer.phone.trim() : null;
}

/** Fixed aliases belong to the recovery routing query; only the phone is bound. */
export function recoveryRecipientCandidateSql(phone: string): Prisma.Sql {
  return Prisma.sql`customer."shopId" = r."shopId"
    AND (c."shopId" IS NULL OR c."shopId" = r."shopId")
    AND (c."customerId" IS NULL OR c."customerId" = r."customerId")
    AND (
      (
        (SELECT count(*) FROM commerce."CustomerPhone" p
          WHERE p."customerId" = customer.id AND p."endedAt" IS NULL) = 1
        AND EXISTS (SELECT 1 FROM commerce."CustomerPhone" p
          WHERE p."customerId" = customer.id AND p."endedAt" IS NULL
            AND p."whatsappNoContact" = false AND p."whatsappNoContactReason" IS NULL
            AND (p."whatsappCanonicalPhone" = ${phone}
              OR (p."whatsappCanonicalPhone" IS NULL
                AND regexp_replace(p.phone, '[^0-9]', '', 'g') = ${phone})))
        AND EXISTS (
          SELECT 1 FROM commerce."RecoveryOutreachAttempt" initial
          JOIN whatsapp."ConversationMessage" sent ON sent.id = initial."outboundMessageId"
          WHERE initial."checkoutRecoveryId" = r.id AND initial.sequence = 1
            AND initial.recipient = ${phone} AND initial."sentAt" IS NOT NULL
            AND sent."conversationId" = c.id AND sent.direction = 'OUTBOUND'
            AND sent."providerMessageId" IS NOT NULL AND sent."sentAt" IS NOT NULL
        )
      ) OR (
        NOT EXISTS (SELECT 1 FROM commerce."CustomerPhone" p WHERE p."customerId" = customer.id)
        AND regexp_replace(regexp_replace(customer.phone, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '^\\+', '') = ${phone}
        AND NOT EXISTS (
          SELECT 1 FROM commerce."RecoveryOutreachAttempt" initial
          LEFT JOIN whatsapp."ConversationMessage" sent ON sent.id = initial."outboundMessageId"
          WHERE initial."checkoutRecoveryId" = r.id AND initial.sequence = 1
            AND (initial.recipient <> ${phone} OR initial."sentAt" IS NULL
              OR sent.id IS NULL OR sent."conversationId" <> c.id
              OR sent."providerMessageId" IS NULL OR sent."sentAt" IS NULL)
        )
      )
    )`;
}
