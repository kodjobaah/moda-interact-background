import type { Prisma, PrismaClient } from "@prisma/client";
import { canonicalWhatsAppSender, matchesRegisteredPhone } from "./phone.js";

export type NoContactReader = Pick<PrismaClient | Prisma.TransactionClient, "$queryRawUnsafe">;

type StoredNoContact = {
  phone: string;
  whatsappCanonicalPhone: string | null;
  defaultCountryCode: string | null;
};

/** Negative-only policy: a STOP/merchant block on ANY active matching record
 * forbids a send to that shop and recipient, regardless of service window.
 * No provider I/O, Redis, or positive Shopify/Woo consent inference.
 */
export async function hasLocalNoContact(
  database: NoContactReader,
  input: { shopId?: string; recipient: string },
): Promise<boolean> {
  const canonical = canonicalWhatsAppSender(input.recipient);
  if (!canonical) return false; // Not a match; recipient validation is a separate provider boundary.
  const blocked = await database.$queryRawUnsafe<StoredNoContact[]>(`
    SELECT cp."phone", cp."whatsappCanonicalPhone", s."defaultCountryCode"
    FROM "commerce"."CustomerPhone" cp
    JOIN "commerce"."Customer" c ON c."id" = cp."customerId"
    JOIN "commerce"."Shop" s ON s."id" = c."shopId"
    WHERE cp."endedAt" IS NULL AND cp."whatsappNoContact" = TRUE
      AND (cp."whatsappCanonicalPhone" = $1 OR cp."whatsappCanonicalPhone" IS NULL)
      AND ($2::text IS NULL OR c."shopId" = $2)
  `, canonical, input.shopId ?? null);
  return blocked.some((phone) => matchesRegisteredPhone(phone, canonical, phone.defaultCountryCode));
}
