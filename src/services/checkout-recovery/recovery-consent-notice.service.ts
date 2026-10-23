import { createHash } from "node:crypto";
import { MerchantSupportMessageKind, MerchantSupportMessageState } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import prisma from "../../lib/db.js";

export type RecoveryConsentNoticeReason =
  | "NO_VERIFIED_OPT_IN"
  | "RECIPIENT_UNVERIFIED"
  | "VERIFICATION_UNAVAILABLE";

const NOTICE_BODY: Record<RecoveryConsentNoticeReason, string> = {
  NO_VERIFIED_OPT_IN:
    "Checkout recovery was not started because verified WhatsApp marketing opt-in is not available for the current recipient. No WhatsApp message was sent or recovery credit used.",
  RECIPIENT_UNVERIFIED:
    "Checkout recovery was not started because the customer's Shopify identity or exact active WhatsApp recipient could not be verified. This is not evidence that the customer refused opt-in. No message was sent or credit used.",
  VERIFICATION_UNAVAILABLE:
    "Checkout recovery was not started because Shopify WhatsApp consent verification was temporarily unavailable. The customer's preference is unknown, not refused. No message was sent or credit used. The current checkout job may retry under its normal retry policy.",
};

type NoticeDatabase = Pick<PrismaClient, "$transaction">;

/** Checkout-keyed Support notice, independent of any recovery row or WhatsApp provider. */
export class RecoveryConsentNoticeService {
  constructor(
    private readonly database: NoticeDatabase = prisma,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async publish(input: {
    shopId: string;
    checkoutToken: string;
    reason: RecoveryConsentNoticeReason;
  }): Promise<"created" | "duplicate"> {
    // Neither the checkout token nor the phone enters the Support source key or body.
    const checkoutDigest = createHash("sha256")
      .update(JSON.stringify(["shopify-checkout-consent:v1", input.shopId, input.checkoutToken]))
      .digest("hex");
    const sourceKey = `shopify-recovery-consent:v1:${checkoutDigest}:${input.reason}`;
    return this.database.$transaction(async (tx) => {
      const thread = await tx.merchantSupportThread.upsert({
        where: { shopId: input.shopId },
        create: { shopId: input.shopId },
        update: {},
      });
      const at = this.now();
      const inserted = await tx.merchantSupportMessage.createMany({
        skipDuplicates: true,
        data: [{
          threadId: thread.id,
          kind: MerchantSupportMessageKind.SYSTEM,
          state: MerchantSupportMessageState.AVAILABLE,
          originalBody: `${NOTICE_BODY[input.reason]} Checkout reference: ${checkoutDigest.slice(0, 16)}.`,
          sourceLanguageTag: "en-GB",
          systemCode: "SHOPIFY_RECOVERY_CONSENT_ADMISSION",
          systemVersion: "1",
          sourceKey,
          availableAt: at,
        }],
      });
      if (inserted.count === 1) {
        await tx.merchantSupportThread.update({
          where: { id: thread.id },
          data: { lastMessageAt: at },
        });
      }
      return inserted.count === 1 ? "created" : "duplicate";
    });
  }
}

export const recoveryConsentNoticeService = new RecoveryConsentNoticeService();
