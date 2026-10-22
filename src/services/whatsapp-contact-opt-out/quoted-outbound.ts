import type { PrismaClient } from "@prisma/client";
import { canonicalWhatsAppSender, matchesRegisteredPhone } from "./phone.js";

/** Only a provider-confirmed outbound to this caller can limit STOP to one shop.
 * A missing/ambiguous reference always falls back to global negative suppression.
 */
export async function resolveQuotedStopShop(
  database: Pick<PrismaClient, "conversationMessage">,
  providerMessageId: string,
  canonicalSender: string,
): Promise<string | null> {
  const original = await database.conversationMessage.findUnique({
    where: { providerMessageId },
    select: {
      direction: true, sentAt: true,
      merchantSendCommand: { select: { shopId: true, recipientSnapshot: true } },
      recoveryOutreachAttempt: {
        select: { recipient: true, checkoutRecovery: { select: { shopId: true } } },
      },
      conversation: {
        select: {
          shopId: true,
          checkoutRecovery: {
            select: {
              shopId: true,
              customer: { select: { phone: true } },
              shop: { select: { defaultCountryCode: true } },
            },
          },
        },
      },
    },
  });
  if (original?.direction !== "OUTBOUND" || !original.sentAt) return null;
  const recovery = original.conversation.checkoutRecovery;
  const shopId = recovery?.shopId ?? original.conversation.shopId;
  if (!shopId || (original.conversation.shopId && original.conversation.shopId !== shopId)) return null;
  if (original.merchantSendCommand && original.merchantSendCommand.shopId !== shopId) return null;
  if (original.recoveryOutreachAttempt && original.recoveryOutreachAttempt.checkoutRecovery.shopId !== shopId) return null;

  const recipient = original.merchantSendCommand?.recipientSnapshot ??
    original.recoveryOutreachAttempt?.recipient ?? recovery?.customer?.phone;
  if (!recipient) return null;
  const verifiedCountry = recovery?.shop.defaultCountryCode;
  const match = matchesRegisteredPhone(
    { phone: recipient, whatsappCanonicalPhone: null }, canonicalSender, verifiedCountry,
  );
  if (!match || !canonicalWhatsAppSender(`+${canonicalSender}`)) return null;
  return shopId;
}
