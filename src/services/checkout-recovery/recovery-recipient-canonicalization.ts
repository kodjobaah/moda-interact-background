/** Canonical storage and provider identities use international digits only. */
export function isCanonicalRecoveryRecipient(
  value: string | null | undefined,
): value is string {
  return typeof value === "string" && /^[1-9][0-9]{1,14}$/.test(value);
}

/** Canonical WhatsApp recipients are international digits, with no inferred country.
 * Accept only familiar phone presentation separators; never strip arbitrary text.
 * This is a syntax/length guard, not proof of ownership or reachability.
 */
export function canonicalizeRecoveryRecipient(
  phone: string | null | undefined,
): string | null {
  const raw = phone?.trim() ?? "";
  if (!/^\+?[0-9 ()-]+$/.test(raw)) return null;
  const digits = raw.replace(/[^0-9]/g, "");
  return isCanonicalRecoveryRecipient(digits) ? digits : null;
}
