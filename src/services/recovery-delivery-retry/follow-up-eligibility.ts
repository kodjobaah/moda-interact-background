import type { Prisma } from "@prisma/client";
import type { WhatsAppSenderIdentity } from "../../integration/whatsapp/types.js";
import type { RecoveryContext } from "../recovery-conversation/recovery-conversation.sql.js";
import { isCheckoutRecoveryWithinLifetime } from "../recovery-lifetime/checkout-recovery-lifetime.js";

type Tx = Prisma.TransactionClient;
export type ScheduledFollowUpRetryScope = {
  shopId: string;
  recoveryId: string;
  conversationId: string;
  intentId: string;
};
export const scheduledFollowUpRetryClaimKey = (intentId: string) =>
  `scheduled-no-response-retry:${intentId}`;

/** Shared current owner check. Caller must hold Shop -> Conversation ->
 * CheckoutRecovery locks. No provider, Redis or HTTP operations. */
export async function scheduledFollowUpRetryOwnerDenial(
  tx: Tx,
  scope: ScheduledFollowUpRetryScope,
  owner: RecoveryContext,
  now: Date,
): Promise<string | null> {
  if (
    owner.id !== scope.conversationId ||
    owner.shopId !== scope.shopId ||
    owner.recoveryId !== scope.recoveryId ||
    owner.mode !== "AI" ||
    owner.lastInboundAt ||
    owner.inboundVersion !== 0
  )
    return "owner-ineligible";
  const recovery = await tx.checkoutRecovery.findUnique({
    where: { id: scope.recoveryId },
    select: {
      shopId: true,
      checkoutToken: true,
      generation: true,
      status: true,
      completedAt: true,
      expiredAt: true,
      lastExternalActivityAt: true,
      admissionBlockReason: true,
      shop: { select: { status: true, platform: true } },
    },
  });
  const config = await tx.backgroundRuntimeConfig.findUnique({
    where: { id: "default" },
    select: { checkoutRecoveryLifetimeDays: true },
  });
  if (
    !config ||
    !recovery ||
    recovery.shopId !== scope.shopId ||
    recovery.shop.status !== "ACTIVE" ||
    !["SHOPIFY", "WOOCOMMERCE"].includes(recovery.shop.platform) ||
    recovery.status !== "MESSAGE_SENT" ||
    recovery.completedAt ||
    recovery.expiredAt ||
    recovery.admissionBlockReason === "WHATSAPP_RECIPIENT_SUPPRESSED" ||
    !isCheckoutRecoveryWithinLifetime({
      now,
      lastExternalActivityAt: recovery.lastExternalActivityAt,
      checkoutRecoveryLifetimeDays: config.checkoutRecoveryLifetimeDays,
    })
  )
    return "recovery-ineligible";
  if (
    await tx.checkoutRecovery.findFirst({
      where: {
        shopId: scope.shopId,
        checkoutToken: recovery.checkoutToken,
        generation: { gt: recovery.generation },
      },
      select: { id: true },
    })
  )
    return "newer-generation";
  const [settings, override] = await Promise.all([
    tx.shopSettings.findUnique({
      where: { shopId: scope.shopId },
      select: { followUpEnabled: true },
    }),
    tx.shopRecoveryPolicyOverride.findUnique({
      where: { shopId: scope.shopId },
      select: { followUpEnabled: true, expiresAt: true },
    }),
  ]);
  if (
    !(
      override && (!override.expiresAt || override.expiresAt > now)
        ? override
        : settings
    )?.followUpEnabled
  )
    return "follow-up-disabled";
  return null;
}

/** All historical attempts must use the still-open assigned sender. Final
 * admission additionally locks and validates this sender against config. */
export async function readScheduledFollowUpRetrySender(
  tx: Tx,
  scope: ScheduledFollowUpRetryScope,
  recipient: string,
  messageIds: string[],
  now: Date,
): Promise<WhatsAppSenderIdentity | null> {
  const assignment = await tx.recoverySenderAssignment.findUnique({
    where: { conversationId: scope.conversationId },
    select: {
      releasedAt: true,
      route: {
        select: {
          closedAt: true,
          shopId: true,
          canonicalRecipient: true,
          providerPhoneNumberId: true,
          thread: {
            select: {
              closedAt: true,
              sender: { select: { providerAccountId: true, verifiedAt: true } },
            },
          },
        },
      },
    },
  });
  const route = assignment?.route;
  if (
    !assignment ||
    assignment.releasedAt ||
    !route ||
    route.closedAt ||
    route.thread.closedAt ||
    route.shopId !== scope.shopId ||
    route.canonicalRecipient !== recipient.replace(/^\+/, "") ||
    route.thread.sender.verifiedAt > now
  )
    return null;
  const messages = await tx.conversationMessage.findMany({
    where: { id: { in: messageIds } },
    select: {
      dispatchProviderAccountId: true,
      dispatchProviderPhoneNumberId: true,
    },
  });
  if (
    !messageIds.length ||
    messages.length !== messageIds.length ||
    messages.some(
      (m) =>
        m.dispatchProviderAccountId !== route.thread.sender.providerAccountId ||
        m.dispatchProviderPhoneNumberId !== route.providerPhoneNumberId,
    )
  )
    return null;
  return {
    providerAccountId: route.thread.sender.providerAccountId,
    providerPhoneNumberId: route.providerPhoneNumberId,
  };
}
