import type { RecordUsageInput, UsageMetric } from "../domain/types.js";
import prisma from "../lib/db.js";

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
        metric,
        quantity,
        idempotencyKey,
        sourceType: sourceType ?? null,
        sourceId: sourceId ?? null,
      },

      update: {},
    });
  }
}