import { Prisma } from "@prisma/client";

export type WooRefundMoneyEvidence = {
  amount: Prisma.Decimal;
  currency: "USD";
};

export type WooRefundEvidenceResult =
  | { charge: Record<string, unknown>; money: WooRefundMoneyEvidence | null; errorCode?: never }
  | { charge?: never; money?: never; errorCode: "WOO_REFUND_CHARGE_EVIDENCE_INVALID" | "WOO_REFUND_AMOUNT_EVIDENCE_INVALID" };

export function parseWooRefundEvidence(
  payload: unknown,
  providerContractId: string | null,
): WooRefundEvidenceResult {
  if (!isRecord(payload) || !isRecord(payload.charge) || !providerContractId) {
    return { errorCode: "WOO_REFUND_CHARGE_EVIDENCE_INVALID" };
  }
  const charge = payload.charge;
  if (charge.id !== providerContractId || !["canceled", "refunded"].includes(String(charge.status))) {
    return { errorCode: "WOO_REFUND_CHARGE_EVIDENCE_INVALID" };
  }
  const money = readLatestRefundAmount(charge.transactions);
  return money === INVALID_MONEY
    ? { errorCode: "WOO_REFUND_AMOUNT_EVIDENCE_INVALID" }
    : { charge, money };
}

const INVALID_MONEY = Symbol("invalid-provider-refund-money");

function readLatestRefundAmount(
  transactionsValue: unknown,
): WooRefundMoneyEvidence | null | typeof INVALID_MONEY {
  if (!Array.isArray(transactionsValue)) return null;
  const transactions = transactionsValue.filter(isRecord)
    .filter((transaction) => typeof transaction.completed_at === "string"
      && Number.isFinite(Date.parse(transaction.completed_at))
      && Object.hasOwn(transaction, "amount_refunded"))
    .sort((left, right) => {
      const timeDifference = Date.parse(String(right.completed_at)) - Date.parse(String(left.completed_at));
      return timeDifference || compareTransactionIds(right.id, left.id);
    });
  const latest = transactions[0];
  if (!latest) return null;
  const amount = parseBoundedMoney(latest.amount_refunded);
  return amount ? { amount, currency: "USD" } : INVALID_MONEY;
}

function parseBoundedMoney(value: unknown): Prisma.Decimal | null {
  try {
    const amount = new Prisma.Decimal(String(value));
    if (!amount.isFinite() || amount.isNegative() || amount.gt("1000000000")) return null;
    return amount.toDecimalPlaces(2).equals(amount) ? amount : null;
  } catch {
    return null;
  }
}

function compareTransactionIds(left: unknown, right: unknown): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber)) return leftNumber - rightNumber;
  return String(left).localeCompare(String(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}