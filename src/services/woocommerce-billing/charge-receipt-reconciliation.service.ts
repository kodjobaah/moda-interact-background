import prisma from "../../lib/db.js";
import { recoveryCapacityResumeService } from "../recovery-capacity-resume.service.js";
import {
  processNextWooChargeReceipt,
  type ChargeReceiptCursor,
  type ChargeReceiptDatabase,
} from "./charge-receipt-processor.js";

export const MAX_WOO_CHARGE_ACQUISITION_RECEIPTS_PER_CYCLE = 50;

export type WooChargeReceiptBatchResult = {
  claimed: number;
  processed: number;
  activated: number;
  canceled: number;
  retryable: number;
};

export class WooChargeReceiptReconciliationService {
  constructor(
    private readonly database: ChargeReceiptDatabase = prisma,
    private readonly now: () => Date = () => new Date(),
    private readonly resumeScheduler: Pick<typeof recoveryCapacityResumeService, "schedule"> = recoveryCapacityResumeService,
  ) {}

  async reconcileBatch(limit = MAX_WOO_CHARGE_ACQUISITION_RECEIPTS_PER_CYCLE): Promise<WooChargeReceiptBatchResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WOO_CHARGE_ACQUISITION_RECEIPTS_PER_CYCLE) {
      throw new Error("Woo charge receipt batch size must be between 1 and 50");
    }
    const result: WooChargeReceiptBatchResult = { claimed: 0, processed: 0, activated: 0, canceled: 0, retryable: 0 };
    let cursor: ChargeReceiptCursor | null = null;
    for (let index = 0; index < limit; index += 1) {
      const attempt = await processNextWooChargeReceipt(this.database, this.now(), cursor, this.resumeScheduler);
      if (attempt.outcome === "empty") break;
      result.claimed += 1;
      cursor = attempt.cursor ?? cursor;
      if (attempt.outcome === "retryable") result.retryable += 1;
      else {
        result.processed += 1;
        if (attempt.transition === "activated") result.activated += 1;
        if (attempt.transition === "canceled") result.canceled += 1;
      }
    }
    return result;
  }
}

export const wooChargeReceiptReconciliationService = new WooChargeReceiptReconciliationService();