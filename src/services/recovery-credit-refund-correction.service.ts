import {
  RecoveryCreditPurchaseStatus,
  RecoveryCreditRefundStatus,
} from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import prisma from "../lib/db.js";
import {
  shopifyPartnerBillingApi,
  type ShopifyPartnerBillingProvider,
} from "../providers/shopify-partner-billing.provider.js";
import {
  RefundCompletionService,
} from "./recovery-credit-refund-correction/refund-completion.service.js";
import {
  RefundPreparationService,
} from "./recovery-credit-refund-correction/refund-preparation.service.js";
import {
  RefundProviderStateService,
} from "./recovery-credit-refund-correction/refund-provider-state.service.js";
import {
  RefundReconciliationService,
  type RefundReconciliationOutcome,
} from "./recovery-credit-refund-correction/refund-reconciliation.service.js";
import {
  refundSelect,
  type RefundRow,
} from "./recovery-credit-refund-correction/refund-correction.types.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const LIVE_RECOVERY_CREDIT_REFUND_STATUSES = [
  RecoveryCreditRefundStatus.REQUESTED,
  RecoveryCreditRefundStatus.PROVIDER_ACTION_REQUIRED,
  RecoveryCreditRefundStatus.NEEDS_ATTENTION,
] as const;

type RefundDatabase = PrismaClient;

export type RecoveryCreditRefundCorrectionResult = {
  selected: number;
  prepared: number;
  reconciled: number;
  completed: number;
  providerActionRequired: number;
  needsAttention: number;
};

export class RecoveryCreditRefundCorrectionService {
  private readonly preparation: RefundPreparationService;
  private readonly reconciliation: RefundReconciliationService;

  constructor(
    private readonly database: RefundDatabase = prisma,
    partner: ShopifyPartnerBillingProvider = shopifyPartnerBillingApi,
    now: () => Date = () => new Date(),
    private readonly pageSize = DEFAULT_PAGE_SIZE,
  ) {
    const providerState = new RefundProviderStateService(database, partner);
    const completion = new RefundCompletionService(database, now);
    this.preparation = new RefundPreparationService(database, providerState, now);
    this.reconciliation = new RefundReconciliationService(
      database,
      providerState,
      completion,
    );
  }

  async processDue(): Promise<RecoveryCreditRefundCorrectionResult> {
    const refunds = await this.database.recoveryCreditRefund.findMany({
      where: { status: RecoveryCreditRefundStatus.REQUESTED },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: boundedPageSize(this.pageSize),
      select: refundSelect,
    });
    const result: RecoveryCreditRefundCorrectionResult = {
      selected: refunds.length,
      prepared: 0,
      reconciled: 0,
      completed: 0,
      providerActionRequired: 0,
      needsAttention: 0,
    };
    const visitedMeters = new Set<string>();
    for (const refund of refunds as unknown as RefundRow[]) {
      const meterKey = refundMeterKey(refund);
      if (visitedMeters.has(meterKey)) continue;
      visitedMeters.add(meterKey);
      let outcome: CorrectionOutcome;
      try {
        outcome = refund.automaticCorrectionUsageEventId
          ? await this.reconciliation.reconcile(refund)
          : await this.prepare(refund);
      } catch (error) {
        outcome = refund.automaticCorrectionUsageEventId
          ? "reconciled"
          : "provider-action-required";
        if (outcome === "provider-action-required") {
          await this.preparation.markProviderActionRequired(
            refund,
            error instanceof Error ? error.message : "provider proof unavailable",
          );
        }
      }
      result.prepared += outcome === "prepared" ? 1 : 0;
      result.reconciled += outcome === "reconciled" ? 1 : 0;
      result.completed += outcome === "completed" ? 1 : 0;
      result.providerActionRequired += outcome === "provider-action-required" ? 1 : 0;
      result.needsAttention += outcome === "needs-attention" ? 1 : 0;
    }
    return result;
  }

  private async prepare(refund: RefundRow): Promise<CorrectionOutcome> {
    if (await this.hasEarlierLiveMeterMutation(refund)) return "reconciled";
    const result = await this.preparation.prepare(refund);
    if (result.kind === "prepared") return "prepared";
    if (result.kind === "provider-action-required") return "provider-action-required";
    return result.refund
      ? this.reconciliation.reconcile(result.refund)
      : "reconciled";
  }

  private async hasEarlierLiveMeterMutation(refund: RefundRow): Promise<boolean> {
    const earlierRefund = await this.database.recoveryCreditRefund.findFirst({
      where: {
        shopId: refund.shopId,
        eventHandleSnapshot: refund.eventHandleSnapshot,
        status: { in: [...LIVE_RECOVERY_CREDIT_REFUND_STATUSES] },
        id: { not: refund.id },
        OR: [
          { createdAt: { lt: refund.createdAt } },
          { createdAt: refund.createdAt, id: { lt: refund.id } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (earlierRefund) return true;
    const unresolvedPurchase = await this.database.recoveryCreditPurchase.findFirst({
      where: {
        shopId: refund.shopId,
        status: RecoveryCreditPurchaseStatus.REQUESTED,
        shopifyEventHandleSnapshot: refund.eventHandleSnapshot,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    return Boolean(unresolvedPurchase);
  }
}

type CorrectionOutcome =
  | RefundReconciliationOutcome
  | "prepared"
  | "provider-action-required";

function refundMeterKey(refund: Pick<RefundRow, "shopId" | "eventHandleSnapshot">): string {
  return JSON.stringify([refund.shopId, refund.eventHandleSnapshot]);
}

function boundedPageSize(value: number): number {
  return Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
}
