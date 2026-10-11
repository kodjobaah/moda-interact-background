import {
  MerchantSupportMessageKind,
  MerchantSupportMessageState,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import {
  ARCH007_BILLING_CONTRACT_SCHEMA_VERSION,
  BILLING_SYSTEM_MESSAGE_CODES,
  createMerchantBillingSystemSourceKey,
} from "@modainteract/moda-interact-shared/billing";

export async function createRefundCompletionSupportMessage(
  transaction: Prisma.TransactionClient,
  input: { shopId: string; refundId: string; body: string; availableAt: Date },
): Promise<void> {
  const systemCode = BILLING_SYSTEM_MESSAGE_CODES.REFUND_COMPLETED;
  const sourceKey = createMerchantBillingSystemSourceKey(
    input.shopId,
    systemCode,
    input.refundId,
    ARCH007_BILLING_CONTRACT_SCHEMA_VERSION,
  );
  const thread = await transaction.merchantSupportThread.upsert({
    where: { shopId: input.shopId },
    create: { shopId: input.shopId },
    update: {},
  });
  await transaction.merchantSupportMessage.upsert({
    where: { sourceKey },
    create: {
      threadId: thread.id,
      kind: MerchantSupportMessageKind.SYSTEM,
      state: MerchantSupportMessageState.AVAILABLE,
      originalBody: input.body,
      sourceLanguageTag: "en-GB",
      systemCode,
      systemVersion: String(ARCH007_BILLING_CONTRACT_SCHEMA_VERSION),
      sourceKey,
      availableAt: input.availableAt,
    },
    update: {},
  });
  await transaction.merchantSupportThread.update({
    where: { id: thread.id },
    data: { lastMessageAt: input.availableAt },
  });
}