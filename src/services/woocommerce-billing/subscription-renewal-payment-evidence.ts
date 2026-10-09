type BillingIntentEvidence = {
  id: string | null;
  status: unknown;
  updatedAt: Date | null;
};

type CompletedPaymentEvidence = {
  at: Date;
  id: string | null;
  intentId: string | null;
};

export function latestCompletedBillingIntentPayment(
  intents: readonly BillingIntentEvidence[],
  payments: readonly CompletedPaymentEvidence[],
): { at: Date; id: string } | null {
  if (intents.some(({ id, updatedAt }) => !id || !updatedAt)) return null;
  const dated = intents.filter((intent) => intent.id && intent.updatedAt);
  if (!dated.length) return null;
  const latestAt = Math.max(...dated.map(({ updatedAt }) => updatedAt!.getTime()));
  const latest = dated.filter(({ updatedAt }) => updatedAt!.getTime() === latestAt);
  if (latest.length !== 1 || latest[0]?.status !== "completed") return null;
  const intentId = latest[0].id;
  const matches = payments.filter((payment) => payment.intentId === intentId && payment.id !== null);
  if (!matches.length) return null;
  const payment = matches.reduce((current, next) => current.at > next.at ? current : next);
  return { at: payment.at, id: payment.id! };
}