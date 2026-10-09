import type { FinancialEvidence } from "./subscription-evidence-reducer.js";

export type WooSubscriptionTopic =
  | "saas_billing_contract.activated"
  | "saas_billing_contract.updated"
  | "saas_billing_contract.renewed"
  | "saas_billing_contract.paused"
  | "saas_billing_contract.canceled"
  | "saas_billing_contract.prepaid_term_ended"
  | "saas_billing_contract.refunded";

export type WooSubscriptionEvidence = {
  topic: WooSubscriptionTopic;
  contractId: string;
  status: string;
  financial: FinancialEvidence | null;
  activationAt: Date | null;
  termEndAt: Date | null;
  providerModifiedAt: Date | null;
  planObservedAt: Date | null;
  planName: string | null;
  planPriceMinor: number | null;
};

export class PermanentSubscriptionEvidenceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type JsonObject = Record<string, unknown>;

export function parseWooSubscriptionEvidence(
  topicValue: string,
  expectedContractId: string,
  normalizedPayload: unknown,
): WooSubscriptionEvidence {
  const topic = topicValue as WooSubscriptionTopic;
  if (!isTopic(topic)) throw new PermanentSubscriptionEvidenceError("UNSUPPORTED_SUBSCRIPTION_TOPIC");
  const root = asObject(normalizedPayload);
  const contract = asObject(root.subscription);
  if (contract.id !== expectedContractId || typeof contract.status !== "string") {
    throw new PermanentSubscriptionEvidenceError("INVALID_SUBSCRIPTION_ENVELOPE");
  }
  const status = contract.status.toLowerCase();
  if (!statusMatchesTopic(topic, status)) {
    throw new PermanentSubscriptionEvidenceError("INCOHERENT_SUBSCRIPTION_STATUS");
  }

  const intents = Array.isArray(contract.billing_intents) ? contract.billing_intents : [];
  const completedIntentIds = new Set(intents
    .filter((value): value is JsonObject => isObject(value) && value.status === "completed")
    .map((intent) => scalarId(intent.id))
    .filter((id): id is string => id !== null));
  const completedPayments = (Array.isArray(contract.transactions) ? contract.transactions : [])
    .filter(isObject)
    .filter((transaction) => {
      const intentId = scalarId(transaction.billing_intent_id);
      return intentId !== null && completedIntentIds.has(intentId);
    })
    .map((transaction) => ({
      at: parseProviderDate(transaction.completed_at),
      id: scalarId(transaction.id),
    }))
    .filter((payment): payment is { at: Date; id: string | null } => payment.at !== null);

  const providerModifiedAt = parseProviderDate(contract.date_modified);
  const nextPaymentAt = parseProviderDate(contract.next_payment_date);
  const activationAt = topic === "saas_billing_contract.activated"
    ? earliest(completedPayments.map(({ at }) => at))
    : null;
  if (topic === "saas_billing_contract.activated" && !activationAt) {
    throw new PermanentSubscriptionEvidenceError("ACTIVATION_PAYMENT_EVIDENCE_MISSING");
  }

  const financialTopic = topic === "saas_billing_contract.activated"
    || topic === "saas_billing_contract.updated"
    || topic === "saas_billing_contract.renewed"
    || topic === "saas_billing_contract.paused";
  const paymentAt = latest(completedPayments.map(({ at }) => at));
  const providerAt = topic === "saas_billing_contract.paused"
    ? latest(intents
      .filter((value): value is JsonObject => isObject(value) && value.status === "failed")
      .map((intent) => parseProviderDate(intent.updated_at))
      .filter((value): value is Date => value !== null)) ?? providerModifiedAt
    : providerModifiedAt ?? paymentAt;
  if (financialTopic && (!providerAt || topic !== "saas_billing_contract.paused" && !nextPaymentAt)) {
    throw new PermanentSubscriptionEvidenceError("FINANCIAL_EVIDENCE_INCOMPLETE");
  }
  if (topic === "saas_billing_contract.renewed" && !paymentAt) {
    throw new PermanentSubscriptionEvidenceError("RENEWAL_PAYMENT_EVIDENCE_MISSING");
  }

  const termTopic = topic === "saas_billing_contract.canceled"
    || topic === "saas_billing_contract.prepaid_term_ended";
  const termEndAt = termTopic ? parseProviderDate(contract.end_date) : null;
  if (termTopic && !termEndAt) throw new PermanentSubscriptionEvidenceError("TERM_END_EVIDENCE_MISSING");

  const price = parsePriceMinor(contract.price);
  return {
    topic,
    contractId: expectedContractId,
    status,
    financial: financialTopic
      ? {
          health: topic === "saas_billing_contract.paused" ? "PAUSED" : "ACTIVE",
          providerAt: providerAt!,
          coverageEndAt: topic === "saas_billing_contract.paused" ? null : nextPaymentAt,
        }
      : null,
    activationAt,
    termEndAt,
    providerModifiedAt,
    planObservedAt: providerModifiedAt,
    planName: typeof contract.name === "string" ? contract.name : null,
    planPriceMinor: price,
  };
}

function isTopic(value: string): value is WooSubscriptionTopic {
  return [
    "saas_billing_contract.activated", "saas_billing_contract.updated",
    "saas_billing_contract.renewed", "saas_billing_contract.paused",
    "saas_billing_contract.canceled", "saas_billing_contract.prepaid_term_ended",
    "saas_billing_contract.refunded",
  ].includes(value);
}

function statusMatchesTopic(topic: WooSubscriptionTopic, status: string): boolean {
  if (["saas_billing_contract.activated", "saas_billing_contract.updated", "saas_billing_contract.renewed"].includes(topic)) return status === "active";
  if (topic === "saas_billing_contract.paused") return status === "paused";
  if (topic === "saas_billing_contract.canceled" || topic === "saas_billing_contract.prepaid_term_ended") return ["canceled", "cancelled", "expired"].includes(status);
  return true;
}

function asObject(value: unknown): JsonObject {
  if (!isObject(value)) throw new PermanentSubscriptionEvidenceError("INVALID_SUBSCRIPTION_ENVELOPE");
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalarId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 || typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : null;
}

function parseProviderDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : null;
}

function parsePriceMinor(value: unknown): number | null {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}

function earliest(values: readonly Date[]): Date | null {
  return values.length ? new Date(Math.min(...values.map((value) => value.getTime()))) : null;
}

function latest(values: readonly Date[]): Date | null {
  return values.length ? new Date(Math.max(...values.map((value) => value.getTime()))) : null;
}