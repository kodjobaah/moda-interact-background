import { createHash } from "node:crypto";

// Diagnostic values are deliberately code-shaped; never emit Shopify payloads,
// checkout URLs, recipients, message bodies, or provider credentials.
const identifier = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)
    ? value : undefined;
const code = (value: unknown): string | undefined =>
  typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value)
    ? value : undefined;
export const checkoutDigest = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0
    ? createHash("sha256").update(value).digest("hex").slice(0, 16) : undefined;

export function checkoutEventOutcomeFields(
  eventType: string,
  input: { shopId?: string; checkoutToken?: string; jobId?: string },
  result: unknown,
) {
  const output = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown> : {};
  return {
    eventType,
    ...(identifier(input.shopId) ? { shopId: identifier(input.shopId) } : {}),
    ...(identifier(input.jobId) ? { jobId: identifier(input.jobId) } : {}),
    ...(checkoutDigest(input.checkoutToken) ? { checkoutDigest: checkoutDigest(input.checkoutToken) } : {}),
    kind: code(output.kind) ?? "unclassified",
    ...(code(output.outcome) ? { outcome: code(output.outcome) } : {}),
    ...(code(output.reason) ? { reason: code(output.reason) } : {}),
    ...(identifier(output.recoveryId) ? { recoveryId: identifier(output.recoveryId) } : {}),
    ...(typeof output.delayMinutes === "number" && Number.isSafeInteger(output.delayMinutes)
      && output.delayMinutes >= 0 ? { delayMinutes: output.delayMinutes } : {}),
  };
}
