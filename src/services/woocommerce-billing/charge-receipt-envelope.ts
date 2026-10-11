export type WooChargeTopic =
  | "saas_billing_contract.activated"
  | "saas_billing_contract.canceled"
  | "saas_billing_contract.prepaid_term_ended";

export type WooChargeEnvelopeResult =
  | { charge: Record<string, unknown>; errorCode?: never }
  | { charge?: never; errorCode: "CHARGE_PROVIDER_STATUS_CONFLICT" };

export function readWooChargeEnvelope(
  normalizedPayload: unknown,
  providerContractId: string | null,
  topic: string,
): WooChargeEnvelopeResult {
  if (!isRecord(normalizedPayload) || !isRecord(normalizedPayload.charge) || !providerContractId) {
    return { errorCode: "CHARGE_PROVIDER_STATUS_CONFLICT" };
  }
  const charge = normalizedPayload.charge;
  const expectedStatus = topic === "saas_billing_contract.activated" ? "active" : "canceled";
  if (typeof charge.id !== "string" || charge.id.trim().length === 0
    || charge.id !== providerContractId || typeof charge.status !== "string"
    || charge.status.trim().length === 0 || charge.status !== expectedStatus) {
    return { errorCode: "CHARGE_PROVIDER_STATUS_CONFLICT" };
  }
  return { charge };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}