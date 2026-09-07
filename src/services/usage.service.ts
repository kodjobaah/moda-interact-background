import type { RecordUsageInput, UsageMetric } from "../domain/types.js";
import { UsageMetric as PrismaUsageMetric } from "@prisma/client";
import prisma from "../lib/db.js";

const metricMap: Record<UsageMetric, PrismaUsageMetric> = {
  monthly_conversations: PrismaUsageMetric.RECOVERY_CONVERSATION,
  monthly_recoveries: PrismaUsageMetric.RECOVERY_CONVERSATION,
  monthly_messages: PrismaUsageMetric.OUTBOUND_AUTOMATED_MESSAGE,
};

export class UsageService {
  async record({
    shopId,
    metric,
    quantity,
    idempotencyKey,
    sourceType,
    sourceId,
  }: RecordUsageInput) {
    return prisma.usageEvent.upsert({
      where: {
        idempotencyKey,
      },

      create: {
        shopId,
        metric: metricMap[metric],
        quantity,
        idempotencyKey,
        sourceType: sourceType ?? null,
        sourceId: sourceId ?? null,
      },

      update: {},
    });
  }
}