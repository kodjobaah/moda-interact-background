/**
 * A recovery conversation event is a non-billable Shopify App Event used for
 * refund evidence. It must be named, but must NOT match a billable meter.
 *
 * These functions consume already-retrieved provider evidence; they never read
 * PostgreSQL or call Shopify. They deliberately preserve handles verbatim.
 */
export function hasValidRecoveryReportingHandle(
  handle: string | null | undefined,
  billableMeterHandles: readonly string[],
): boolean {
  return typeof handle === "string"
    && handle.trim().length > 0
    && !billableMeterHandles.includes(handle);
}

/** A credit-pack purchase IS billed and must match a configured usage meter. */
export function hasConfiguredCreditPackMeter(
  handle: string | null | undefined,
  billableMeterHandles: readonly string[],
): boolean {
  return typeof handle === "string"
    && handle.length > 0
    && billableMeterHandles.includes(handle);
}
