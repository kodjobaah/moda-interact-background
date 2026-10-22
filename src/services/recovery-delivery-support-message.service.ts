import { MerchantSupportMessageKind, MerchantSupportMessageState } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import prisma from "../lib/db.js";
import {
  RECOVERY_DELIVERY_FAILURE_SYSTEM_CODE,
  RECOVERY_DELIVERY_FAILURE_SYSTEM_VERSION,
  recoveryDeliveryNoticeSourceKey,
} from "./recovery-delivery-notification-content.js";

type SupportDatabase = Pick<PrismaClient, "$transaction" | "merchantSupportMessage">;
export type SupportNoticeOutcome = "created" | "duplicate";

/** Independent support transaction: cannot roll back earlier credit/reachability commits. */
export class RecoveryDeliverySupportMessageService {
  constructor(
    private readonly database: SupportDatabase = prisma,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async write(input: {
    shopId: string; recoveryId: string; messageId: string; body: string;
  }): Promise<SupportNoticeOutcome> {
    const sourceKey = recoveryDeliveryNoticeSourceKey(
      input.shopId, input.recoveryId, input.messageId,
    );
    try {
      await this.database.$transaction(async (tx) => {
        const thread = await tx.merchantSupportThread.upsert({
          where: { shopId: input.shopId },
          create: { shopId: input.shopId },
          update: {},
        });
        const now = this.now();
        await tx.merchantSupportMessage.create({
          data: {
            threadId: thread.id,
            kind: MerchantSupportMessageKind.SYSTEM,
            state: MerchantSupportMessageState.AVAILABLE,
            originalBody: input.body,
            sourceLanguageTag: "en-GB",
            systemCode: RECOVERY_DELIVERY_FAILURE_SYSTEM_CODE,
            systemVersion: RECOVERY_DELIVERY_FAILURE_SYSTEM_VERSION,
            sourceKey,
            availableAt: now,
          },
        });
        await tx.merchantSupportThread.update({
          where: { id: thread.id },
          data: { lastMessageAt: now },
        });
      });
      return "created";
    } catch (error) {
      // Only a confirmed existing message is a successful duplicate. A competing
      // thread creation or unrelated unique constraint must remain retryable.
      if (typeof error === "object" && error !== null && "code" in error &&
        error.code === "P2002") {
        const existing = await this.database.merchantSupportMessage.findUnique({
          where: { sourceKey }, select: { id: true },
        });
        if (existing) return "duplicate";
      }
      throw error;
    }
  }
}

export const recoveryDeliverySupportMessageService = new RecoveryDeliverySupportMessageService();
