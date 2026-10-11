import { Prisma } from "@prisma/client";

export type ChargePaymentEvidenceError =
  | "CHARGE_PAYMENT_EVIDENCE_INCOMPLETE"
  | "CHARGE_PAYMENT_EVIDENCE_AMBIGUOUS"
  | "CHARGE_PAYMENT_AMOUNT_INVALID";

export type ChargePaymentEvidence = {
  billingIntentId: number;
  transactionId: number;
  amount: Prisma.Decimal;
  amountRefunded: Prisma.Decimal;
};

export type ChargePaymentEvidenceResult =
  | { evidence: ChargePaymentEvidence; errorCode?: never }
  | { evidence?: never; errorCode: ChargePaymentEvidenceError };

export type WooChargePriceSnapshotInput = {
  merchantPricingUsageEventId: string;
  quotedAmountMinor: number;
  quotedCurrency: string;
};

export function parseChargePaymentEvidence(charge: unknown): ChargePaymentEvidenceResult {
  if (!isRecord(charge)) return incomplete();
  const intents = Array.isArray(charge.billing_intents) ? charge.billing_intents : [];
  const transactions = Array.isArray(charge.transactions) ? charge.transactions : [];
  if (intents.length === 0 || transactions.length === 0) return incomplete();

  const completedIntentIds = new Set(
    intents.flatMap((intent) => isRecord(intent)
      && intent.status === "completed"
      && isPositiveSafeInteger(intent.id)
      ? [intent.id]
      : []),
  );
  const candidates = transactions.filter((transaction) => isRecord(transaction)
    && isPositiveSafeInteger(transaction.id)
    && isPositiveSafeInteger(transaction.billing_intent_id)
    && completedIntentIds.has(transaction.billing_intent_id)
    && typeof transaction.completed_at === "string"
    && transaction.completed_at.trim().length > 0);
  if (candidates.length === 0) return incomplete();
  if (candidates.length > 1) return { errorCode: "CHARGE_PAYMENT_EVIDENCE_AMBIGUOUS" };

  const transaction = candidates[0];
  if (!isRecord(transaction)) return incomplete();
  const amount = parseDecimal(transaction.amount);
  const amountRefunded = parseDecimal(transaction.amount_refunded);
  if (!amount || !amountRefunded || !amount.gt(0) || amountRefunded.lt(0)) {
    return { errorCode: "CHARGE_PAYMENT_AMOUNT_INVALID" };
  }
  if (!amountRefunded.isZero()) return incomplete();

  const intentId = transaction.billing_intent_id;
  if (!isPositiveSafeInteger(intentId) || !isPositiveSafeInteger(transaction.id)) return incomplete();
  return {
    evidence: {
      billingIntentId: intentId,
      transactionId: transaction.id,
      amount,
      amountRefunded,
    },
  };
}

export function createWooChargePriceSnapshot(
  operation: WooChargePriceSnapshotInput,
  evidence: ChargePaymentEvidence,
): Prisma.InputJsonObject {
  return {
    schemaVersion: 1,
    provider: "WOOCOMMERCE",
    kind: "ONE_TIME_CHARGE",
    merchantPricingUsageEventId: operation.merchantPricingUsageEventId,
    quotedAmountMinor: operation.quotedAmountMinor,
    quotedCurrency: operation.quotedCurrency,
    providerBillingIntentId: String(evidence.billingIntentId),
    providerTransactionId: String(evidence.transactionId),
    providerTransactionAmount: canonicalDecimal(evidence.amount),
    providerAmountRefunded: canonicalDecimal(evidence.amountRefunded),
  };
}

function parseDecimal(value: unknown): Prisma.Decimal | null {
  try {
    const decimal = new Prisma.Decimal(String(value));
    return decimal.isFinite() ? decimal : null;
  } catch {
    return null;
  }
}

function canonicalDecimal(value: Prisma.Decimal): string {
  const fixed = value.toFixed();
  if (!fixed.includes(".")) return fixed;
  return fixed.replace(/0+$/, "").replace(/\.$/, "") || "0";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function incomplete(): ChargePaymentEvidenceResult {
  return { errorCode: "CHARGE_PAYMENT_EVIDENCE_INCOMPLETE" };
}