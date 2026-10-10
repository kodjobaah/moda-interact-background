import prisma from "../../lib/db.js";
import { processNextWooSubscriptionReceipt } from "./subscription-receipt-processor.js";

export type WooSubscriptionReceiptBatchResult = {
  claimed: number;
  processed: number;
  historical: number;
  needsAttention: number;
};

export class WooSubscriptionReceiptReconciliationService {
  constructor(
    private readonly database = prisma,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcileBatch(limit: number): Promise<WooSubscriptionReceiptBatchResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("Woo subscription receipt batch size must be between 1 and 200");
    }
    const result: WooSubscriptionReceiptBatchResult = {
      claimed: 0,
      processed: 0,
      historical: 0,
      needsAttention: 0,
    };
    for (let index = 0; index < limit; index += 1) {
      const outcome = await processNextWooSubscriptionReceipt(this.database, this.now());
      if (outcome === "empty") break;
      result.claimed += 1;
      if (outcome === "historical") result.historical += 1;
      else if (outcome === "attention") result.needsAttention += 1;
      else result.processed += 1;
    }
    return result;
  }
}

export const wooSubscriptionReceiptReconciliationService = new WooSubscriptionReceiptReconciliationService();