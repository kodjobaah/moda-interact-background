import prisma from "../../lib/db.js";
import {
  processNextWooRefundReceipt,
  type WooRefundReceiptCursor,
  type WooRefundReceiptDatabase,
} from "./charge-refund-receipt-processor.js";

export const MAX_WOO_CHARGE_REFUND_RECEIPTS_PER_CYCLE = 50;

export type WooChargeRefundReceiptBatchResult = {
  claimed: number;
  processed: number;
  retryable: number;
};

export class WooChargeRefundReceiptReconciliationService {
  constructor(
    private readonly database: WooRefundReceiptDatabase = prisma,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcileBatch(limit = MAX_WOO_CHARGE_REFUND_RECEIPTS_PER_CYCLE): Promise<WooChargeRefundReceiptBatchResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WOO_CHARGE_REFUND_RECEIPTS_PER_CYCLE) {
      throw new Error("Woo charge refund receipt batch size must be between 1 and 50");
    }
    const result: WooChargeRefundReceiptBatchResult = { claimed: 0, processed: 0, retryable: 0 };
    let cursor: WooRefundReceiptCursor | null = null;
    for (let index = 0; index < limit; index += 1) {
      const attempt = await processNextWooRefundReceipt(this.database, this.now(), cursor);
      if (attempt.outcome === "empty") break;
      result.claimed += 1;
      cursor = attempt.cursor ?? cursor;
      if (attempt.outcome === "processed") result.processed += 1;
      else result.retryable += 1;
    }
    return result;
  }
}

export const wooChargeRefundReceiptReconciliationService = new WooChargeRefundReceiptReconciliationService();