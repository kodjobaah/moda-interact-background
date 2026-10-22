import { UsageMetric } from "@prisma/client";
import { requireLineage, type CompensationTransaction } from "./types.js";
import type { AutomatedUsage } from "./lineage.js";

/** Never delete by provider ID, phone number, or conversation-wide quota. */
export async function readExactAutomatedUsage(
  tx: CompensationTransaction, shopId: string, messageId: string,
): Promise<AutomatedUsage | null> {
  const matches = await tx.usageEvent.findMany({
    where: { sourceId: messageId, metric: UsageMetric.OUTBOUND_AUTOMATED_MESSAGE },
    select: { id: true, shopId: true, idempotencyKey: true, sourceType: true },
    take: 2,
  });
  requireLineage(matches.length <= 1, "duplicate outbound usage for message");
  const usage = matches[0] ?? null;
  requireLineage(!usage || usage.shopId === shopId, "outbound usage shop mismatch");
  return usage;
}

export async function removeExactAutomatedUsage(
  tx: CompensationTransaction, shopId: string, messageId: string, usage: AutomatedUsage | null,
): Promise<void> {
  if (!usage) return;
  const deleted = await tx.usageEvent.deleteMany({
    where: { id: usage.id, shopId, sourceId: messageId, metric: UsageMetric.OUTBOUND_AUTOMATED_MESSAGE },
  });
  requireLineage(deleted.count === 1, "outbound usage deletion conflict");
}
