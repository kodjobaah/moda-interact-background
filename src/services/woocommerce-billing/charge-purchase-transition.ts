import { Prisma } from "@prisma/client";
import {
  createWooChargePriceSnapshot,
  type ChargePaymentEvidence,
} from "./charge-payment-evidence.js";
import type { ChargeReceiptLink } from "./charge-receipt-correlation.js";

type Transaction = Prisma.TransactionClient;
type ReceiptTopic = "saas_billing_contract.activated" | "saas_billing_contract.canceled" | "saas_billing_contract.prepaid_term_ended";
type TransitionError = "CHARGE_OPERATION_STATE_CONFLICT" | "CHARGE_PURCHASE_STATE_CONFLICT" | "PURCHASED_COUNTER_STATE_CONFLICT";

export type ChargeTransitionResult =
  | { outcome: "activated" | "replayed" | "canceled" | "cancellation_replayed"; newlyActivated: boolean; errorCode?: never }
  | { outcome?: never; newlyActivated: false; errorCode: TransitionError };

const UNRESOLVED_OPERATION_STATES = ["AWAITING_CONFIRMATION", "OUTCOME_UNKNOWN"] as const;
const TERMINAL_PURCHASE_STATUSES = ["ACTIVE", "WITHDRAWN", "COMPLETED", "REFUNDED"] as const;

export async function transitionChargePurchase(
  transaction: Transaction,
  link: ChargeReceiptLink,
  input: {
    topic: ReceiptTopic;
    providerContractId: string;
    receivedAt: Date;
    paymentEvidence?: ChargePaymentEvidence;
  },
): Promise<ChargeTransitionResult> {
  if (input.topic !== "saas_billing_contract.activated") {
    return terminateUnactivatedCharge(transaction, link, input.providerContractId);
  }

  if (link.operation.state === "CONFIRMED") {
    return isConfirmedPurchaseReplay(link.purchase, input.providerContractId)
      ? { outcome: "replayed", newlyActivated: false }
      : { errorCode: "CHARGE_PURCHASE_STATE_CONFLICT", newlyActivated: false };
  }
  if (!UNRESOLVED_OPERATION_STATES.includes(link.operation.state as typeof UNRESOLVED_OPERATION_STATES[number])) {
    return { errorCode: "CHARGE_OPERATION_STATE_CONFLICT", newlyActivated: false };
  }
  if (!isPristineRequestedPurchase(link.purchase)) {
    return { errorCode: "CHARGE_PURCHASE_STATE_CONFLICT", newlyActivated: false };
  }
  if (link.counter && !isValidCounter(link.counter)) {
    return { errorCode: "PURCHASED_COUNTER_STATE_CONFLICT", newlyActivated: false };
  }
  if (!input.paymentEvidence) return { errorCode: "CHARGE_PURCHASE_STATE_CONFLICT", newlyActivated: false };

  const snapshot = createWooChargePriceSnapshot({
    merchantPricingUsageEventId: link.operation.merchantPricingUsageEventId!,
    quotedAmountMinor: link.operation.quotedAmountMinor!,
    quotedCurrency: link.operation.quotedCurrency!,
  }, input.paymentEvidence);
  const activation = await transaction.recoveryCreditPurchase.updateMany({
    where: {
      id: link.purchase.id,
      version: link.purchase.version,
      status: "REQUESTED",
      currentAmount: 0,
      reservedAmount: 0,
      provider: "WOOCOMMERCE",
      providerReference: null,
      providerPurchaseAmount: null,
      providerPurchaseCurrency: null,
      providerValuationConfirmedAt: null,
      providerPriceSnapshot: { equals: Prisma.DbNull },
      usageEventId: null,
    },
    data: {
      providerReference: input.providerContractId,
      providerPurchaseAmount: input.paymentEvidence.amount,
      providerPurchaseCurrency: "USD",
      providerValuationConfirmedAt: input.receivedAt,
      providerPriceSnapshot: snapshot,
      currentAmount: link.purchase.creditsGranted,
      reservedAmount: 0,
      status: "ACTIVE",
      activatedAt: input.receivedAt,
      version: { increment: 1 },
    },
  });
  if (activation.count !== 1) return { errorCode: "CHARGE_PURCHASE_STATE_CONFLICT", newlyActivated: false };

  if (link.counter) {
    const counterUpdate = await transaction.shopEntitlementCounter.updateMany({
      where: {
        id: link.counter.id,
        version: link.counter.version,
        counter: "PURCHASED_RECOVERY_CREDITS",
      },
      data: {
        grantedQuantity: { increment: link.purchase.creditsGranted },
        version: { increment: 1 },
      },
    });
    if (counterUpdate.count !== 1) throw new Error("Purchased recovery counter compare-and-set failed");
  } else {
    await transaction.shopEntitlementCounter.create({
      data: {
        shopId: link.shop.id,
        counter: "PURCHASED_RECOVERY_CREDITS",
        grantedQuantity: link.purchase.creditsGranted,
        committedQuantity: 0,
        reservedQuantity: 0,
        refundingQuantity: 0,
        version: 1,
      },
    });
  }

  const operationUpdate = await transaction.billingOperation.updateMany({
    where: { id: link.operation.id, state: { in: [...UNRESOLVED_OPERATION_STATES] } },
    data: { state: "CONFIRMED", lastErrorCode: null },
  });
  if (operationUpdate.count !== 1) throw new Error("Billing operation compare-and-set failed after purchase activation");
  return { outcome: "activated", newlyActivated: true };
}

async function terminateUnactivatedCharge(
  transaction: Transaction,
  link: ChargeReceiptLink,
  providerContractId: string,
): Promise<ChargeTransitionResult> {
  if (link.operation.state === "CONFIRMED"
    && TERMINAL_PURCHASE_STATUSES.includes(link.purchase.status as typeof TERMINAL_PURCHASE_STATUSES[number])
    && link.purchase.provider === "WOOCOMMERCE"
    && link.purchase.providerReference === providerContractId) {
    return { outcome: "canceled", newlyActivated: false };
  }
  if (link.operation.state === "FAILED"
    && link.operation.lastErrorCode === "WOO_CHARGE_CANCELED_BEFORE_ACTIVATION"
    && link.purchase.status === "REQUESTED"
    && link.purchase.currentAmount === 0
    && link.purchase.reservedAmount === 0) {
    return { outcome: "cancellation_replayed", newlyActivated: false };
  }
  if (!UNRESOLVED_OPERATION_STATES.includes(link.operation.state as typeof UNRESOLVED_OPERATION_STATES[number])
    || !isPristineRequestedPurchase(link.purchase)) {
    return { errorCode: "CHARGE_OPERATION_STATE_CONFLICT", newlyActivated: false };
  }
  const updated = await transaction.billingOperation.updateMany({
    where: { id: link.operation.id, state: { in: [...UNRESOLVED_OPERATION_STATES] } },
    data: { state: "FAILED", lastErrorCode: "WOO_CHARGE_CANCELED_BEFORE_ACTIVATION" },
  });
  return updated.count === 1
    ? { outcome: "canceled", newlyActivated: false }
    : { errorCode: "CHARGE_OPERATION_STATE_CONFLICT", newlyActivated: false };
}

function isPristineRequestedPurchase(purchase: ChargeReceiptLink["purchase"]): boolean {
  return purchase.status === "REQUESTED"
    && purchase.currentAmount === 0
    && purchase.reservedAmount === 0
    && purchase.provider === "WOOCOMMERCE"
    && purchase.providerReference === null
    && purchase.providerPurchaseAmount === null
    && purchase.providerPurchaseCurrency === null
    && purchase.providerValuationConfirmedAt === null
    && purchase.providerPriceSnapshot === null
    && purchase.usageEventId === null;
}

function isConfirmedPurchaseReplay(
  purchase: ChargeReceiptLink["purchase"],
  providerContractId: string,
): boolean {
  return TERMINAL_PURCHASE_STATUSES.includes(purchase.status as typeof TERMINAL_PURCHASE_STATUSES[number])
    && purchase.provider === "WOOCOMMERCE"
    && purchase.providerReference === providerContractId
    && purchase.providerPurchaseAmount !== null
    && purchase.providerPurchaseCurrency === "USD"
    && purchase.providerValuationConfirmedAt !== null
    && purchase.providerPriceSnapshot !== null;
}

function isValidCounter(counter: NonNullable<ChargeReceiptLink["counter"]>): boolean {
  return [
    counter.grantedQuantity,
    counter.committedQuantity,
    counter.reservedQuantity,
    counter.refundingQuantity,
    counter.version,
  ].every((value) => Number.isSafeInteger(value) && value >= 0);
}